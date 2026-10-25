"""compute/resume.py: interruptible generation for the order router (owner Lucy)."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx

from compute.config import Settings
from compute.main import create_app

KEY = "resume-test-key"
MSGS = [{"role": "user", "content": "Explain VWAP in one line please"}]


def make_app(tmp_path, **overrides):
    os.environ["RESUME_MOCK_TIME_SCALE"] = overrides.pop("scale", "50")
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0, internal_api_key=KEY,
                       **overrides)
    return create_app(settings)


class LiveServer:
    """Runs the app on a real port so tokens stream as they are generated (the ASGI test transport buffers)."""

    def __init__(self, app):
        import socket
        import threading

        import uvicorn

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        import time

        self.thread.start()
        while not self.server.started:
            time.sleep(0.01)
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=5)


async def read_stream(client, body, on_event=None):
    events = []
    async with client.stream("POST", "/v1/resume/stream", json=body, headers={"X-MS-Internal-Key": KEY}) as r:
        assert r.status_code == 200, await r.aread()
        async for line in r.aiter_lines():
            if line.startswith("data: "):
                ev = json.loads(line[6:])
                events.append(ev)
                if on_event:
                    await on_event(ev)
    return events


async def full_reply(client):
    events = await read_stream(client, {"gpuId": "gpu-a", "messages": MSGS, "maxTokens": 400})
    return events[-1]


def test_interrupted_at_60_percent_resumes_on_another_gpu_as_one_reply(tmp_path):
    asyncio.run(_test_interrupted_at_60_percent_resumes_on_another_gpu_as_one_reply(tmp_path))


async def _test_interrupted_at_60_percent_resumes_on_another_gpu_as_one_reply(tmp_path):
    app = make_app(tmp_path)
    with LiveServer(app) as url:
        async with httpx.AsyncClient(base_url=url, timeout=30) as client:
            whole = await full_reply(client)
            assert whole["kind"] == "done"
            total = whole["tokens"]
            cut = int(total * 0.6)

            async def interrupt_at_60(ev):
                if ev["kind"] == "token" and ev["tokens"] == cut:
                    await client.post("/v1/resume/interrupt", headers={"X-MS-Internal-Key": KEY},
                                      json={"gpuId": "gpu-a", "reason": "RECLAIMED", "move": True})

            first = await read_stream(client, {"gpuId": "gpu-a", "messages": MSGS, "maxTokens": 400}, interrupt_at_60)
            stop = first[-1]
            assert stop["kind"] == "interrupted" and stop["reason"] == "RECLAIMED"
            assert first[-2]["kind"] == "checkpoint" and first[-2]["text"] == stop["text"]
            assert cut <= stop["tokens"] < total
            # The reclaimed GPU no longer admits work.
            refused = await client.post("/v1/resume/stream", headers={"X-MS-Internal-Key": KEY},
                                        json={"gpuId": "gpu-a", "messages": MSGS, "maxTokens": 10})
            assert refused.status_code == 503
            # Continue on gpu-b from the checkpoint: prompt plus partial answer.
            second = await read_stream(client, {"gpuId": "gpu-b", "messages": MSGS, "maxTokens": 400,
                                                "resume": {"text": stop["text"], "tokens": stop["tokens"]}})
            done = second[-1]
            assert done["kind"] == "done" and done["text"] == whole["text"]  # one continuous reply
            served_first = sum(1 for e in first if e["kind"] == "token")
            served_second = sum(1 for e in second if e["kind"] == "token")
            assert served_first + served_second == total  # no token generated (or billed) twice


def test_rebalance_checkpoints_without_moving(tmp_path):
    asyncio.run(_test_rebalance_checkpoints_without_moving(tmp_path))


async def _test_rebalance_checkpoints_without_moving(tmp_path):
    app = make_app(tmp_path)
    with LiveServer(app) as url:
        async with httpx.AsyncClient(base_url=url, timeout=30) as client:
            fired = False

            async def rebalance(ev):
                nonlocal fired
                if ev["kind"] == "token" and ev["tokens"] == 5 and not fired:
                    fired = True
                    await client.post("/v1/resume/interrupt", headers={"X-MS-Internal-Key": KEY},
                                      json={"gpuId": "gpu-a", "reason": "REBALANCE", "move": False})

            events = await read_stream(client, {"gpuId": "gpu-a", "messages": MSGS, "maxTokens": 400}, rebalance)
            assert any(e["kind"] == "checkpoint" and e.get("reason") == "REBALANCE" for e in events)
            assert events[-1]["kind"] == "done"


def test_booking_drain_window_interrupts_the_stream(tmp_path):
    asyncio.run(_test_booking_drain_window_interrupts_the_stream(tmp_path))


async def _test_booking_drain_window_interrupts_the_stream(tmp_path):
    # Admitted with runway to spare (the estimate uses the GPU's planning speed), but this reply runs at a
    # quarter of that speed, so a booking's drain window opens while it is still generating.
    app = make_app(tmp_path, scale="0.1", drain_lead_seconds=2.0, guard_seconds=0.5, prefill_seconds=0.1)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://c") as client:
            start = datetime.now(UTC) + timedelta(seconds=4)
            r = await client.post("/bookings", headers={"X-MS-Internal-Key": KEY}, json={
                "gpu_id": "gpu-a", "slot_start": start.isoformat(), "slots": 1, "redemption_id": "r1",
                "holder": "BOB"})
            assert r.status_code == 200, r.text
            events = await asyncio.wait_for(
                read_stream(client, {"gpuId": "gpu-a", "messages": MSGS, "maxTokens": 20}), timeout=20)
            stop = events[-1]
            assert stop["kind"] == "interrupted" and stop["reason"] == "BOOKING"
            assert 0 < stop["tokens"] < 20
            assert events[-2]["kind"] == "checkpoint" and events[-2]["text"] == stop["text"]


def test_interrupt_requires_internal_key(tmp_path):
    asyncio.run(_test_interrupt_requires_internal_key(tmp_path))


async def _test_interrupt_requires_internal_key(tmp_path):
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://c") as client:
            r = await client.post("/v1/resume/interrupt", json={"gpuId": "gpu-a"})
            assert r.status_code == 401

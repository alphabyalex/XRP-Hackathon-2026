"""Resume, don't restart: token-level checkpoints and interruptible generation for the order router.

All of the router's compute code lives in this module (owner Lucy, services/router). Hooks in
Tharun's files: one install() call in main.py and GpuSupervisor.set_offline() in scheduler.py.

  POST /v1/resume/stream     SSE generation that the router can stop and continue on another GPU.
                             Body: {gpuId, messages, maxTokens, resume: {text, tokens}, checkpointEvery,
                             reportUsage, chargePerToken, buyer}. A resume sends the original messages plus
                             the partial answer; vLLM continues the same assistant message
                             (continue_final_message), so the reply stays one continuous text.
                             Events: token, checkpoint (every N tokens and at the signal), interrupted, done.
  POST /v1/resume/interrupt  {gpuId, reason, move, durationSeconds}: checkpoint now; move=true also stops
                             the streams and takes the GPU out of public admission for durationSeconds.

Triggers that call interrupt(): a booking about to start on the GPU (the scheduler's DRAINING state),
the router (manual reclaim, EventBridge Spot warnings), and provider notices polled on the worker:
EC2 IMDS spot/instance-action and events/recommendations/rebalance (RESUME_EC2_IMDS=1, every 5 s),
Azure Scheduled Events Preempt (RESUME_AZURE_EVENTS=1, every 1 s), GCP preempted metadata
(RESUME_GCP_METADATA=1, every 1 s).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
from fastapi import FastAPI, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .models import ChatMessage, ComputeError, UsageEvent
from .providers import MockProvider, VllmProvider, estimate_text_tokens
from .scheduler import Scheduler

log = logging.getLogger("compute.resume")

DRAIN_CHECK_SECONDS = 1.0
REASONS_THAT_CLOSE_ADMISSION = {"RECLAIMED", "CAPACITY_BLOCK_ENDING"}


class ResumeState(BaseModel):
    text: str = ""
    tokens: int = Field(default=0, ge=0)


class StreamRequest(BaseModel):
    gpuId: str  # noqa: N815
    messages: list[ChatMessage] = Field(min_length=1)
    maxTokens: int = Field(default=256, ge=1, le=8192)  # noqa: N815
    resume: ResumeState = Field(default_factory=ResumeState)
    checkpointEvery: int = Field(default=16, ge=1, le=1024)  # noqa: N815
    reportUsage: bool = False  # noqa: N815 (the router reports usage itself at settlement)
    chargePerToken: str = "0"  # noqa: N815
    buyer: str = "ROUTER"


class InterruptRequest(BaseModel):
    gpuId: str  # noqa: N815
    reason: str = "RECLAIMED"
    move: bool = True
    durationSeconds: float = 300.0  # noqa: N815


@dataclass(eq=False)  # identity hashing: flags live in sets
class Flag:
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str = ""
    move: bool = True


class Hub:
    """Live streams per GPU, so one interrupt reaches every reply running there."""

    def __init__(self) -> None:
        self.flags: dict[str, set[Flag]] = {}

    def add(self, gpu: str) -> Flag:
        f = Flag()
        self.flags.setdefault(gpu, set()).add(f)
        return f

    def remove(self, gpu: str, f: Flag) -> None:
        self.flags.get(gpu, set()).discard(f)

    def interrupt(self, gpu: str, reason: str, move: bool) -> int:
        n = 0
        for f in list(self.flags.get(gpu, ())):
            f.reason, f.move = reason, move
            f.event.set()
            n += 1
        return n


def sse(kind: str, **data: Any) -> str:
    return f"data: {json.dumps({'kind': kind, **data})}\n\n"


async def mock_tokens(provider: MockProvider, req: StreamRequest, tokens_per_sec: float, scale: float) -> AsyncIterator[str]:
    """Deterministic for the same messages, so a resume continues exactly where the last GPU stopped."""
    completion = await provider.complete(messages=req.messages, model="", max_tokens=req.maxTokens, temperature=None)
    words = completion.content.split(" ")
    words = [w if i == 0 else " " + w for i, w in enumerate(words)][: req.maxTokens]
    for w in words[req.resume.tokens:]:
        await asyncio.sleep(1.0 / max(tokens_per_sec, 1.0) / scale)
        yield w


async def vllm_tokens(provider: VllmProvider, req: StreamRequest, model: str) -> AsyncIterator[str]:
    messages: list[dict[str, str]] = [m.model_dump() for m in req.messages]
    partial = req.resume.text
    if partial:
        messages.append({"role": "assistant", "content": partial})
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max(1, req.maxTokens - req.resume.tokens),
        "stream": True,
        "add_generation_prompt": not partial,
        "continue_final_message": bool(partial),
        "chat_template_kwargs": {"enable_thinking": False},
    }
    async with httpx.AsyncClient(timeout=None) as http:
        async with http.stream("POST", f"{provider.base_url}/v1/chat/completions", json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                delta = json.loads(line[6:])["choices"][0].get("delta", {}).get("content")
                if delta:
                    yield delta


def install(app: FastAPI, scheduler: Scheduler, providers: dict[str, Any], settings: Any, router: Any) -> Hub:
    hub = Hub()
    scale = float(os.getenv("RESUME_MOCK_TIME_SCALE", "1"))

    def check_key(key: str | None) -> None:
        if key != settings.internal_api_key:
            raise ComputeError("UNAUTHORIZED", "A valid internal API key is required.", 401)

    async def watch_drain(gpu: str, flag: Flag) -> None:
        worker = scheduler.worker(gpu)
        while not flag.event.is_set():
            await asyncio.sleep(DRAIN_CHECK_SECONDS)
            if (await worker.status()).get("state") == "DRAINING":
                hub.interrupt(gpu, "BOOKING", True)

    async def generate(req: StreamRequest) -> AsyncIterator[str]:
        worker = scheduler.worker(req.gpuId)
        provider = providers[req.gpuId]
        request_id = f"req_{uuid.uuid4().hex}"
        runtime = (req.maxTokens - req.resume.tokens) / max(worker.tokens_per_sec, 0.1) + settings.prefill_seconds
        await worker.admit_public(request_id, runtime)  # respects bookings and drain windows
        flag = hub.add(req.gpuId)
        drain = asyncio.create_task(watch_drain(req.gpuId, flag))
        text, n, start_n = req.resume.text, req.resume.tokens, req.resume.tokens
        started = datetime.now(UTC)
        ok = False
        try:
            source = (
                mock_tokens(provider, req, worker.tokens_per_sec, scale)
                if isinstance(provider, MockProvider)
                else vllm_tokens(provider, req, worker.model)
            )
            async for piece in source:
                if flag.event.is_set():
                    yield sse("checkpoint", text=text, tokens=n, reason=flag.reason)
                    if flag.move:
                        yield sse("interrupted", text=text, tokens=n, reason=flag.reason)
                        ok = True
                        return
                    flag.event.clear()
                text += piece
                n += 1
                yield sse("token", text=piece, tokens=n)
                if n % req.checkpointEvery == 0:
                    yield sse("checkpoint", text=text, tokens=n)
            yield sse("done", text=text, tokens=n)
            ok = True
        finally:
            drain.cancel()
            hub.remove(req.gpuId, flag)
            await worker.release(request_id, succeeded=ok)
            if req.reportUsage and n > start_n:
                served = n - start_n
                charge = (Decimal(req.chargePerToken) * served).quantize(Decimal("0.000001"))
                await router.usage_reporter.report(UsageEvent(
                    request_id=request_id, gpu_id=req.gpuId, buyer=req.buyer, booking_id=None,
                    input_tokens=sum(estimate_text_tokens(m.content) for m in req.messages) if start_n == 0 else 0,
                    output_tokens=served, charge=f"{charge:f}", started_at=started,
                    finished_at=datetime.now(UTC), simulated=settings.mock or worker.simulated,
                ))

    @app.post("/v1/resume/stream")
    async def resume_stream(req: StreamRequest, key: str | None = Header(default=None, alias="X-MS-Internal-Key")):
        check_key(key)
        if req.gpuId not in providers:
            raise ComputeError("INVALID_REQUEST", f"Unknown GPU {req.gpuId}.", 404)
        gen = generate(req)
        try:
            first = await anext(gen)  # surface admission errors (booked, draining, offline) as HTTP 409
        except StopAsyncIteration:
            first = ""

        async def body() -> AsyncIterator[str]:
            if first:
                yield first
            async for chunk in gen:
                yield chunk

        return StreamingResponse(body(), media_type="text/event-stream")

    @app.post("/v1/resume/interrupt")
    async def resume_interrupt(req: InterruptRequest, key: str | None = Header(default=None, alias="X-MS-Internal-Key")):
        check_key(key)
        interrupt(req.gpuId, req.reason, req.move, req.durationSeconds)
        return {"gpuId": req.gpuId, "reason": req.reason, "move": req.move,
                "streams": len(hub.flags.get(req.gpuId, ()))}

    def interrupt(gpu: str, reason: str, move: bool, duration: float = 300.0) -> int:
        n = hub.interrupt(gpu, reason, move)
        if move and reason in REASONS_THAT_CLOSE_ADMISSION and gpu in scheduler.workers:
            worker = scheduler.worker(gpu)
            worker.set_offline(True)

            async def reopen() -> None:
                await asyncio.sleep(duration)
                worker.set_offline(False)

            asyncio.get_running_loop().create_task(reopen())
        return n

    async def poll_notices() -> None:
        """Provider reclaim notices seen from inside the worker. Each is opt-in by env flag."""
        ec2, azure, gcp = (os.getenv(k) == "1" for k in ("RESUME_EC2_IMDS", "RESUME_AZURE_EVENTS", "RESUME_GCP_METADATA"))
        if not (ec2 or azure or gcp):
            return
        tick = 0
        async with httpx.AsyncClient(timeout=1.0) as http:
            while True:
                await asyncio.sleep(1.0)
                tick += 1
                try:
                    if ec2 and tick % 5 == 0:  # AWS recommends checking every 5 seconds
                        token = (await http.put("http://169.254.169.254/latest/api/token",
                                                headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"})).text
                        h = {"X-aws-ec2-metadata-token": token}
                        if (await http.get("http://169.254.169.254/latest/meta-data/spot/instance-action",
                                           headers=h)).status_code == 200:
                            for gpu in scheduler.workers:
                                interrupt(gpu, "RECLAIMED", True)
                        if (await http.get("http://169.254.169.254/latest/meta-data/events/recommendations/rebalance",
                                           headers=h)).status_code == 200:
                            for gpu in scheduler.workers:
                                hub.interrupt(gpu, "REBALANCE", False)
                    if azure:
                        events = (await http.get("http://169.254.169.254/metadata/scheduledevents",
                                                 params={"api-version": "2020-07-01"},
                                                 headers={"Metadata": "true"})).json().get("Events", [])
                        if any(e.get("EventType") == "Preempt" for e in events):
                            for gpu in scheduler.workers:
                                interrupt(gpu, "RECLAIMED", True)
                    if gcp:
                        r = await http.get("http://metadata.google.internal/computeMetadata/v1/instance/preempted",
                                           headers={"Metadata-Flavor": "Google"})
                        if r.text.strip().upper() == "TRUE":
                            for gpu in scheduler.workers:
                                interrupt(gpu, "RECLAIMED", True)
                except (httpx.HTTPError, ValueError):
                    continue

    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(a: FastAPI) -> AsyncIterator[None]:
        poller = asyncio.create_task(poll_notices())
        async with original(a):
            yield
        poller.cancel()

    app.router.lifespan_context = lifespan
    app.state.resume_hub = hub
    return hub

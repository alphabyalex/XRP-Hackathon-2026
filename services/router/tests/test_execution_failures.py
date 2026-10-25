"""Live generation fails closed and a failed task receives its full price cap back."""

from __future__ import annotations

import dataclasses
import json

import httpx
import pytest

from router import config as C
from router import settle as S
from router.collectors.base import CollectContext
from router.engine import ComputeEngine, GenEvent, Signal, engine_for
from router.errors import RouterError
from router.orders import OrderCreate, Orders
from router.service import Service
from router.state import SqliteState


@pytest.mark.parametrize("partial", [False, True])
async def test_failed_task_refunds_full_cap_including_after_partial_output(tmp_path, monkeypatch, partial):
    import router.orders as order_module

    payments = []

    def api(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith("/internal/usage"):
            return httpx.Response(200, json={"ok": True})
        payments.append(body)
        return httpx.Response(200, json={"hash": "A" * 64, "result": "tesSUCCESS", "validated": True})

    class FailedEngine:
        async def stream(self, *args):
            if partial:
                yield GenEvent("token", "unfinished", 1)
            raise RouterError(503, "UPSTREAM_ERROR", "The endpoint rejected generation")

    monkeypatch.setattr(C, "SETTLEMENT", "api")
    monkeypatch.setattr(S, "TRANSPORT", httpx.MockTransport(api))
    monkeypatch.setattr(order_module, "engine_for", lambda entry: FailedEngine())
    service = Service()
    service.collect(ctx=CollectContext())
    orders = Orders(service, SqliteState(tmp_path / "orders.db"))
    orders.compute_transport = httpx.MockTransport(lambda request: httpx.Response(503))
    order = await orders.create(OrderCreate(kind="inference", maxTokens=40,
                                           requests=[[{"role": "user", "content": "Hi"}]]))
    await orders.pay(order["orderId"])
    failed = await orders.execute(order["orderId"])
    assert failed["status"] == "failed" and failed["executionFailed"] is True
    assert failed["segments"][0]["served"] == int(partial)
    assert failed["segments"][0]["endedAt"] is not None
    settled = await orders.settle(order["orderId"])
    assert settled["charged"] == "0.000000"
    assert settled["refund"]["amountUsdc"] == settled["capUsdc"]
    assert settled["settlements"] == []
    assert [payment["memoType"] for payment in payments] == ["MS_ORDER", "MS_REFUND"]
    assert all(not orders.state.holders(part["gpuId"]) for part in settled["plan"]["parts"])


@pytest.mark.parametrize("event", [{"kind": "token", "text": "partial", "tokens": 1},
                                   {"kind": "error", "reason": "UPSTREAM_ERROR"}])
async def test_compute_stream_requires_a_successful_terminal_event(event):
    service = Service()
    service.collect(ctx=CollectContext())
    entry = dataclasses.replace(service.entries[0], endpoint="http://worker")
    engine = ComputeEngine(httpx.MockTransport(lambda request: httpx.Response(200,
        text=f"data: {json.dumps(event)}\n\n", headers={"Content-Type": "text/event-stream"})))
    with pytest.raises(RouterError) as error:
        _ = [item async for item in engine.stream(entry, [{"role": "user", "content": "Hi"}], 10, "", 0, Signal())]
    assert error.value.code == "UPSTREAM_ERROR"


def test_live_entry_without_endpoint_cannot_use_local_answers(monkeypatch):
    service = Service()
    service.collect(ctx=CollectContext())
    entry = dataclasses.replace(service.entries[0], endpoint=None)
    monkeypatch.setattr(C, "FLEET_SOURCE", "live")
    with pytest.raises(RouterError) as error:
        engine_for(entry)
    assert error.value.code == "GPU_OFFLINE"

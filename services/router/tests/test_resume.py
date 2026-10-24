"""Resume, don't restart: moves across GPUs and providers, triggered by every kind of reclaim."""

import copy
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from router import aws_events
from router import config as C
from router import settle as S
from router.catalog import now_utc
from router.collectors.base import CollectContext
from router.engine import answer_for
from router.main import app
from router.orders import OrderCreate, Orders
from router.service import Service
from router.state import SqliteState
from tests.test_orders import VWAP, FakeApi

DOCS = json.loads((C.CONTRACTS_DIR / "aws_events.json").read_text())["examples"]
SPOT_WARNING = DOCS["spotInterruption"]  # the documented sample, instance id mapped to GPU-A2
REBALANCE = DOCS["rebalanceRecommendation"]
BLOCK_EXPIRY = DOCS["capacityBlockExpirationWarning"]


def with_instance(event, instance):
    e = copy.deepcopy(event)
    e["detail"]["instance-id"] = instance
    e["resources"] = [f"arn:aws:ec2:us-east-2a:instance/{instance}"]
    return e


@pytest.fixture
def api(monkeypatch):
    fake = FakeApi()
    monkeypatch.setattr(C, "SETTLEMENT", "api")
    monkeypatch.setattr(S, "TRANSPORT", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def orders(tmp_path):
    svc = Service()
    svc.collect(ctx=CollectContext())
    o = Orders(svc, SqliteState(tmp_path / "s.db"))
    o.compute_transport = httpx.MockTransport(lambda r: httpx.Response(503))
    return o


def trigger_at(orders, token_index, action):
    """Run `action` exactly when the reply reaches token_index (deterministic interruption point)."""
    real_emit = orders.emit
    fired = []

    def emit(order, kind, data, persist=True):
        real_emit(order, kind, data, persist)
        if kind == "token" and data["index"] == token_index and not fired:
            fired.append(True)
            action(order)

    orders.emit = emit
    return fired


async def run(orders, req):
    order = await orders.create(req)
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    return await orders.settle(order["orderId"])


def current_gpu(order):
    return order["segments"][-1]["gpuId"]


async def test_interrupted_at_60_percent_resumes_as_one_continuous_reply(orders, api):
    full = "".join(answer_for(VWAP)[:200])
    total = len(answer_for(VWAP)[:200])
    cut = int(total * 0.6)
    fired = trigger_at(orders, cut, lambda o: orders.reclaim(current_gpu(o), 2, "RECLAIMED"))
    order = await run(orders, OrderCreate(kind="inference", mode="balanced", maxTokens=200, requests=[VWAP]))
    assert fired and order["status"] == "settled"
    assert order["output"][0] == full  # one continuous reply
    assert order["restarts"] == 0
    first, second = order["segments"]
    assert first["served"] == cut and second["served"] == total - cut  # nothing generated or billed twice
    assert first["gpuId"] != second["gpuId"] and second["reason"] == "RECLAIMED"
    move = order["moves"][0]
    assert move["resumedAt"] == cut and move["from"] == first["gpuId"] and move["to"] == second["gpuId"]
    served = {x["gpuId"]: x["served"] for x in order["settlements"]}
    assert served == {first["gpuId"]: cut, second["gpuId"]: total - cut}
    settle_memos = {
        p["memo"]["gpuId"]: p["memo"]["tokensOrMinutes"] for p in api.payments if p["memoType"] == "MS_SETTLE"
    }
    assert all(settle_memos[g] == served[g] for g in settle_memos)
    usage = {u["request_id"].split("-", 1)[1]: u["output_tokens"] for u in api.usage}
    assert usage == {first["gpuId"]: cut, second["gpuId"]: total - cut}


async def test_cross_provider_move_continues_the_same_reply(orders, api):
    # Cheapest T4 is Azure spot; once Azure takes it back, the rest runs on another provider's T4.
    trigger_at(orders, 10, lambda o: orders.reclaim(current_gpu(o), 30, "RECLAIMED"))
    order = await run(
        orders,
        OrderCreate(kind="inference", mode="cheapest", maxTokens=200, requests=[VWAP], constraints={"gpuModel": "T4"}),
    )
    move = order["moves"][0]
    assert move["fromProvider"] == "azure" and move["toProvider"] != "azure"
    assert order["output"][0] == "".join(answer_for(VWAP)[:200])
    assert all(seg["gpuId"] != "gpu-a3" for seg in order["segments"][1:])  # reclaimed GPU not reused


def aws_spot_order():
    # Cheapest T4 outside Azure is AWS spot (GPU-A2, instance i-0a2c4e6f8a0b2c4d6).
    return OrderCreate(
        kind="inference",
        mode="cheapest",
        maxTokens=200,
        requests=[VWAP],
        constraints={"gpuModel": "T4", "excludeProviders": ["azure"]},
    )


async def test_eventbridge_spot_warning_moves_the_job(orders, api):
    event = with_instance(SPOT_WARNING, "i-0a2c4e6f8a0b2c4d6")
    results = []
    trigger_at(orders, 12, lambda o: results.append(aws_events.handle(event, orders.service.entries, orders.reclaim)))
    order = await run(orders, aws_spot_order())
    assert order["segments"][0]["gpuId"] == "gpu-a2"
    assert results[0]["action"] == "reclaim" and results[0]["gpuIds"] == ["gpu-a2"]
    assert results[0]["affectedOrders"] == [order["orderId"]]
    assert order["moves"][0]["from"] == "gpu-a2" and order["moves"][0]["reason"] == "RECLAIMED"
    assert order["output"][0] == "".join(answer_for(VWAP)[:200]) and order["restarts"] == 0


async def test_rebalance_recommendation_checkpoints_without_moving(orders, api):
    event = with_instance(REBALANCE, "i-0a2c4e6f8a0b2c4d6")
    results = []
    trigger_at(orders, 12, lambda o: results.append(aws_events.handle(event, orders.service.entries, orders.reclaim)))
    order = await run(orders, aws_spot_order())
    assert results[0]["action"] == "checkpoint" and results[0]["reason"] == "REBALANCE"
    assert order["moves"] == [] and len(order["segments"]) == 1
    kinds = [(e["type"], e["data"].get("reason")) for e in order["events"]]
    assert ("checkpointed", "REBALANCE") in kinds
    assert orders.state.get_checkpoint(f"{order['orderId']}#0")["tokens"] >= 12
    assert not orders.service.state.reclaimed("gpu-a2", now_utc())  # still admitting work


async def test_capacity_block_expiry_moves_work_off_the_reservation(orders, api):
    results = []
    trigger_at(
        orders,
        8,
        lambda o: results.append(
            aws_events.handle(
                BLOCK_EXPIRY
                | {"detail": {"capacity-reservation-id": "cr-0b2d4f6a8c0e2a4b6", "end-date": "2026-10-24T23:00:00Z"}},
                orders.service.entries,
                orders.reclaim,
            )
        ),
    )
    order = await run(
        orders,
        OrderCreate(
            kind="inference", mode="cheapest", maxTokens=200, requests=[VWAP], constraints={"gpuModel": "A10G"}
        ),
    )
    assert order["segments"][0]["gpuId"] == "gpu-b2"
    assert results[0]["reason"] == "CAPACITY_BLOCK_ENDING"
    # Only one A10G in the fleet: the remaining work falls back to any GPU rather than failing.
    assert order["status"] == "settled" and order["moves"][0]["from"] == "gpu-b2"


def test_unknown_or_unrelated_events_are_ignored(orders):
    assert (
        aws_events.handle(with_instance(SPOT_WARNING, "i-0000000000000000"), orders.service.entries, orders.reclaim)[
            "reason"
        ]
        == "UNKNOWN_INSTANCE"
    )
    other = {"source": "aws.ec2", "detail-type": "EC2 Instance State-change Notification", "detail": {}}
    assert aws_events.handle(other, orders.service.entries, orders.reclaim)["reason"] == "UNSUPPORTED_EVENT"


async def test_booking_drain_window_moves_the_job(orders, api):
    from datetime import timedelta

    def booking_soon(order):
        gpu = current_gpu(order)
        entry = orders.service.entry(gpu)
        start = now_utc() + timedelta(seconds=5)
        orders.service.state.compute_windows[entry.computeGpuId] = [(start, start + timedelta(minutes=10))]
        assert orders.check_drains() == [order["orderId"]]

    trigger_at(orders, 10, booking_soon)
    order = await run(
        orders,
        OrderCreate(
            kind="inference",
            mode="balanced",
            maxTokens=200,
            requests=[VWAP],
            constraints={"excludeProviders": ["aws", "azure", "vast"]},
        ),
    )
    assert order["segments"][0]["provider"] == "moonshift"
    assert order["moves"][0]["reason"] == "BOOKING"
    assert order["output"][0] == "".join(answer_for(VWAP)[:200])


async def test_rental_resumes_remaining_minutes_elsewhere(orders, api, monkeypatch):
    monkeypatch.setattr(C, "RENTAL_TIME_SCALE", 300.0)  # 5 rented minutes per tick
    real_emit = orders.emit
    fired = []

    def emit(order, kind, data, persist=True):
        real_emit(order, kind, data, persist)
        if kind == "progress" and data["done"] >= 12 and not fired:
            fired.append(True)
            orders.reclaim(current_gpu(order), 30, "RECLAIMED")

    orders.emit = emit
    order = await run(orders, OrderCreate(kind="rental", mode="cheapest", minutes=30))
    assert fired and len(order["moves"]) == 1
    assert sum(s["served"] for s in order["segments"]) == pytest.approx(30)
    assert order["restarts"] == 0


def test_http_aws_events_endpoint():
    with TestClient(app) as client:
        r = client.post("/internal/aws-events", json=with_instance(SPOT_WARNING, "i-0a2c4e6f8a0b2c4d6"))
        body = r.json()
        assert r.status_code == 200 and body["action"] == "reclaim" and body["gpuIds"] == ["gpu-a2"]
        fleet = {g["id"]: g for g in client.get("/fleet").json()}
        assert fleet["gpu-a2"]["state"]["reason"] == "RECLAIMED"
        client.app.state.orders.service.state.reclaims.clear()

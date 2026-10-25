import asyncio
import dataclasses
import json
import secrets
import time

import boto3
import httpx
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from router import config as C
from router import settle as S
from router.collectors.base import CollectContext
from router.dispatch import Dispatcher, LocalQueue, SqsQueue
from router.main import app
from router.orders import OrderCreate, Orders
from router.service import Service
from router.state import DynamoState, LeaseTaken, SqliteState

VWAP = [{"role": "user", "content": "Explain VWAP in one line"}]


class FakeApi:
    """apps/api POST /internal/router/pay: records payments, answers like the real route."""

    def __init__(self, fail_memo: str | None = None):
        self.payments: list[dict] = []
        self.usage: list[dict] = []
        self.fail_memo = fail_memo

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        if req.url.path.endswith("/internal/usage"):
            self.usage.append(body)
            return httpx.Response(200, json={"ok": True})
        if body["memoType"] == self.fail_memo:
            return httpx.Response(502, json={"error": {"code": "PAYMENT_FAILED", "message": "tecUNFUNDED_PAYMENT"}})
        self.payments.append(body)
        h = secrets.token_hex(32).upper()
        return httpx.Response(
            200,
            json={
                "hash": h,
                "result": "tesSUCCESS",
                "validated": True,
                "explorerUrl": f"https://devnet.xrpl.org/transactions/{h}",
            },
        )


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


async def run(orders, req):
    order = await orders.create(req)
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    return await orders.settle(order["orderId"])


async def test_inference_order_end_to_end_with_devnet_settlement(orders, api):
    order = await run(
        orders, OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP])
    )
    assert order["status"] == "settled"
    assert order["output"][0].startswith("VWAP, the volume weighted average price")
    served = sum(s["served"] for s in order["segments"])
    assert served == len(order["output"][0].split(" "))
    assert order["restarts"] == 0
    kinds = [p["memoType"] for p in api.payments]
    assert kinds[0] == "MS_ORDER" and kinds[-1] == "MS_REFUND" and "MS_SETTLE" in kinds
    first = api.payments[0]
    # The buyer sets aside the cap (estimate x 1.25 by default), not just the estimate.
    assert first["from"] == "ALICE" and first["to"] == "PROTOCOL_FEES" and first["amount"] == order["capUsdc"]
    assert float(order["capUsdc"]) == pytest.approx(float(order["estimateUsdc"]) * 1.25, abs=1e-6)
    assert first["memo"] == {"orderId": order["orderId"], "mode": "balanced", "capUsdc": order["capUsdc"]}
    assert order["payment"]["hash"] and order["payment"]["explorerUrl"].startswith("https://devnet.xrpl.org/")
    # Paid out never exceeds what the buyer set aside; refund covers the rest exactly.
    out = sum(float(p["amount"]) for p in api.payments if p["memoType"] == "MS_SETTLE")
    kept = sum(float(x["providerCostUsdc"]) for x in order["settlements"])
    assert out + kept + float(order["refund"]["amountUsdc"]) == pytest.approx(float(order["capUsdc"]), abs=2e-6)
    for line in order["settlements"]:
        if line.get("hash"):
            settle_tx = next(p for p in api.payments if p["memo"].get("gpuId") == line["gpuId"])
            assert settle_tx["memo"]["tokensOrMinutes"] == line["served"]


async def test_external_capacity_pays_only_margin_to_pool(orders, api):
    order = await run(orders, OrderCreate(kind="inference", mode="cheapest", maxTokens=30, requests=[VWAP]))
    line = order["settlements"][0]
    assert line["provider"] != "moonshift"  # the cheapest single reply is on external capacity
    total = float(line["amountUsdc"])
    assert float(line["toPoolUsdc"]) == pytest.approx(total * C.margin() / (1 + C.margin()), abs=2e-6)
    assert line["to"] in ("TREASURY_GPU_A", "TREASURY_GPU_B")


async def test_payment_failure_releases_leases(orders, monkeypatch):
    fake = FakeApi(fail_memo="MS_ORDER")
    monkeypatch.setattr(C, "SETTLEMENT", "api")
    monkeypatch.setattr(S, "TRANSPORT", httpx.MockTransport(fake.handler))
    order = await orders.create(OrderCreate(kind="inference", maxTokens=20, requests=[VWAP]))
    gpu = order["plan"]["parts"][0]["gpuId"]
    assert order["orderId"] in orders.state.holders(gpu)
    with pytest.raises(Exception) as e:
        await orders.pay(order["orderId"])
    assert "PAYMENT_FAILED" in str(e.value.code)
    assert orders.state.holders(gpu) == []
    assert orders.get(order["orderId"])["status"] == "failed"


async def test_rental_books_compute_slots_for_moonshift_gpus(orders, api, monkeypatch):
    bookings = []

    def compute(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/bookings":
            bookings.append(json.loads(req.content))
            return httpx.Response(200, json={"booking_id": "b1"})
        return httpx.Response(200, json=[])

    orders.compute_transport = httpx.MockTransport(compute)
    # Rented time at the clock's own speed: the compute calendar gets the slots.
    monkeypatch.setattr(C, "RENTAL_TIME_SCALE", 1.0)
    monkeypatch.setattr(C, "RENTAL_TICK_SECONDS", 0.0001)
    order = await run(orders, OrderCreate(kind="rental", mode="fastest", minutes=30))
    assert order["status"] == "settled"
    assert sum(s["served"] for s in order["segments"]) == pytest.approx(30)
    ms_parts = [p for p in order["plan"]["parts"] if p["provider"] == "moonshift"]
    assert len(bookings) == len(ms_parts)
    for b in bookings:
        assert b["gpu_id"] in ("gpu-a", "gpu-b") and b["holder"] == "ALICE"
        assert b["redemption_id"].startswith(order["orderId"])
        assert b["slot_start"].endswith(("0:00Z", "5:00Z"))


async def test_in_process_rental_holds_the_gpu_only_for_its_real_time(orders, api):
    # Rented minutes run RENTAL_TIME_SCALE times faster than the clock: booking the full rented minutes on
    # the compute calendar left an unused window that made the next rental there fail.
    bookings = []

    def compute(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/bookings":
            bookings.append(json.loads(req.content))
        return httpx.Response(200, json=[])

    orders.compute_transport = httpx.MockTransport(compute)
    first = await run(orders, OrderCreate(kind="rental", mode="fastest", minutes=30))
    second = await run(orders, OrderCreate(kind="rental", mode="fastest", minutes=30))
    assert first["status"] == second["status"] == "settled" and bookings == []
    for o in (first, second):
        assert sum(s["served"] for s in o["segments"]) == pytest.approx(30)


def test_leases_never_double_book(tmp_path):
    st = SqliteState(tmp_path / "l.db")
    st.acquire("gpu-x", 1, "o1", 60, now=1000)
    with pytest.raises(LeaseTaken):
        st.acquire("gpu-x", 1, "o2", 60, now=1001)
    assert st.acquire("gpu-x", 1, "o2", 60, now=1061) == 0  # the first lease expired
    assert st.holders("gpu-x", now=1062) == ["o2"]
    assert not st.renew("gpu-x", 0, "o1", 60)


@mock_aws
def test_dynamodb_leases_use_conditional_writes():
    ddb = boto3.client("dynamodb", region_name=C.AWS_REGION)
    for table, keys in ((C.ORDERS_TABLE, ["pk", "sk"]), (C.CHECKPOINTS_TABLE, ["pk"])):
        ddb.create_table(
            TableName=table,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": k, "AttributeType": "S"} for k in keys],
            KeySchema=[{"AttributeName": k, "KeyType": "HASH" if i == 0 else "RANGE"} for i, k in enumerate(keys)],
        )
    st = DynamoState(boto3.client)
    now = time.time()
    assert st.acquire("gpu-x", 2, "o1", 60, now=now) == 0
    assert st.acquire("gpu-x", 2, "o2", 60, now=now) == 1
    with pytest.raises(LeaseTaken):
        st.acquire("gpu-x", 2, "o3", 60, now=now)
    st.release("gpu-x", "o1")
    assert st.acquire("gpu-x", 2, "o3", 60, now=now) == 0
    assert sorted(st.holders("gpu-x", now=now)) == ["o2", "o3"]
    st.put_order({"orderId": "o9", "createdAt": "2026-10-24T22:00:00Z", "status": "paid"})
    assert st.get_order("o9")["status"] == "paid"


async def test_local_queue_drains_fastest_first():
    q = LocalQueue()
    await q.send("cheapest", {"orderId": "c"})
    await q.send("balanced", {"orderId": "b"})
    await q.send("fastest", {"orderId": "f"})
    got = [(await q.receive())[0]["orderId"] for _ in range(3)]
    assert got == ["f", "b", "c"]


async def test_sqs_dispatch_round_trip():
    with mock_aws():
        sqs = boto3.client("sqs", region_name=C.AWS_REGION)
        for t in ("fastest", "balanced", "cheapest"):
            sqs.create_queue(QueueName=f"{C.QUEUE_PREFIX}-{t}")
        q = SqsQueue(boto3.client)
        await q.send("balanced", {"orderId": "o1"})
        body, extend, delete = await q.receive()
        assert body == {"orderId": "o1"}
        extend()
        delete()
        attrs = sqs.get_queue_attributes(QueueUrl=q.urls["balanced"], AttributeNames=["ApproximateNumberOfMessages"])
        assert int(attrs["Attributes"]["ApproximateNumberOfMessages"]) == 0


async def test_dispatcher_runs_paid_orders_to_settlement(orders, api):
    d = Dispatcher(orders, LocalQueue(), workers=2)
    d.start()
    try:
        order = await orders.create(OrderCreate(kind="inference", mode="fastest", maxTokens=20, requests=[VWAP, VWAP]))
        paid = await d.submit(order["orderId"])
        assert paid["status"] == "paid"
        for _ in range(200):
            await asyncio.sleep(0.02)
            if orders.get(order["orderId"])["status"] == "settled":
                break
        assert orders.get(order["orderId"])["status"] == "settled"
    finally:
        d.stop()


def test_http_order_and_events(api):
    with TestClient(app) as client:
        r = client.post("/orders", json={"kind": "inference", "mode": "balanced", "maxTokens": 20, "requests": [VWAP]})
        assert r.status_code == 200, r.text
        order = r.json()
        assert order["status"] in ("paid", "running", "completed", "settled")
        assert "requests" not in order and order["payment"]["hash"]
        oid = order["orderId"]
        for _ in range(300):
            if client.get(f"/orders/{oid}").json()["status"] == "settled":
                break
            time.sleep(0.02)
        final = client.get(f"/orders/{oid}").json()
        assert final["status"] == "settled" and final["output"][0]
        with client.stream("GET", f"/orders/{oid}/events") as s:
            text = "".join(s.iter_text())
        kinds = [line[7:] for line in text.splitlines() if line.startswith("event: ")]
        assert kinds[0] == "quoted" and "paid" in kinds and "completed" in kinds and kinds[-1] == "settled"
        assert client.get("/orders/nope").status_code == 404
        bad = client.post("/orders", json={"kind": "inference", "mode": "turbo", "requests": [VWAP]})
        assert bad.status_code == 422


async def test_reading_an_order_never_breaks_its_settlement(orders, api):
    from router.main import public

    order = await orders.create(OrderCreate(kind="inference", maxTokens=10, requests=[VWAP]))
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    public(orders.get(order["orderId"]))  # an HTTP read mid-run
    assert (await orders.settle(order["orderId"]))["status"] == "settled"

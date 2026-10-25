"""Router-signed settlement: the cap is locked in an XRPL escrow, released in one all-or-nothing Batch that
pays every GPU treasury and provider for the work it served and refunds the buyer the rest, exactly."""

import asyncio
import hashlib
import random
from decimal import Decimal

import pytest

from router import config as C
from router import ledger as L
from router import settle as S
from router.engine import answer_for
from router.orders import OrderCreate
from tests.fake_ledger import FakeLedger
from tests.test_cap import until
from tests.test_orders import VWAP
from tests.test_resume import FakeApi, current_gpu, orders, trigger_at  # noqa: F401 (fixtures)

import httpx

START = {"ALICE": "500", "DEV": "500", "BOB": "500", "PROTOCOL_FEES": "0"}


@pytest.fixture
def ledger(monkeypatch):
    fake = FakeLedger(START)
    monkeypatch.setattr(C, "SETTLEMENT", "api")
    monkeypatch.setattr(C, "LEDGER_SIGNER", "router")
    L.set_backend(fake)
    yield fake
    L.set_backend(None)


def total(fake: FakeLedger) -> Decimal:
    return sum(fake.balances.values(), Decimal(0)) + sum((e["amount"] for e in fake.escrows.values()), Decimal(0))


async def run(orders, req):
    order = await orders.create(req)
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    return await orders.settle(order["orderId"])


def paid_to(fake, tag_prefix):
    return sum((Decimal(t["amount"]) for t in fake.txs if t.get("tag", "").startswith(tag_prefix)), Decimal(0))


async def test_cap_is_locked_in_escrow_before_any_work(orders, ledger):  # noqa: F811
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP]))
    await orders.pay(order["orderId"])
    order = orders.get(order["orderId"])
    assert order["payment"]["kind"] == "escrow"
    (escrow,) = order["escrows"]
    assert escrow["amountUsdc"] == order["capUsdc"]
    assert ledger.bal("ALICE") == Decimal("500") - Decimal(order["capUsdc"])  # locked, not yet anyone's
    assert ledger.bal("PROTOCOL_FEES") == 0  # Moonshift does not hold it until settlement
    assert escrow["cancelAfter"] >= ledger.now + C.ESCROW_MIN_SECONDS  # the buyer's safety valve
    assert ledger.escrows[(escrow["owner"], escrow["sequence"])]["memo"][0] == "MS_ORDER"


async def test_one_batch_releases_escrow_pays_everyone_and_refunds_exactly(orders, ledger):  # noqa: F811
    before = total(ledger)
    order = await run(orders, OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP]))
    assert order["status"] == "settled"
    cap = Decimal(order["capUsdc"])
    pools = paid_to(ledger, "pool:")
    providers = paid_to(ledger, "provider:")
    refund = Decimal(order["refund"]["amountUsdc"])
    assert pools + providers + refund == cap  # exact, to the micro-unit
    assert Decimal(order["charged"]) == pools + providers
    assert ledger.bal("PROTOCOL_FEES") == 0  # the order account passes everything through
    assert ledger.escrows == {}  # the escrow is released
    assert total(ledger) == before  # no TDX created or lost
    assert len(ledger.batches) == 1 and ledger.batches[0][0] == "escrow:0"  # finish first, one atomic Batch
    assert order["payment"]["finishHash"] and order["refund"]["batch"]
    assert all(x["hash"] for x in order["settlements"] if Decimal(x["toPoolUsdc"]) > 0)


async def test_external_provider_share_is_paid_on_chain_to_its_account(orders, ledger):  # noqa: F811
    order = await run(orders, OrderCreate(kind="inference", mode="cheapest", buyer="DEV", maxTokens=30, requests=[VWAP]))
    line = order["settlements"][0]
    assert line["provider"] != "moonshift"
    account = L.provider_account_name(line["provider"])
    assert line["providerAccount"] == account and line["providerHash"]
    assert ledger.bal(account) == Decimal(line["providerCostUsdc"]) > 0
    assert ledger.bal(line["to"]) == Decimal(line["toPoolUsdc"])  # the margin goes to the pool treasury


async def test_work_split_across_providers_after_a_reclaim_is_paid_to_each(orders, ledger):  # noqa: F811
    n = len(answer_for(VWAP)[:200])
    fired = trigger_at(orders, n // 2, lambda o: orders.reclaim(current_gpu(o), 2, "RECLAIMED"))
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", buyer="BOB", maxTokens=200, requests=[VWAP], bufferPct=50))
    await orders.pay(order["orderId"])
    task = asyncio.create_task(orders.execute(order["orderId"]))
    assert await until(lambda: task.done() or orders.get(order["orderId"])["status"] == "paused")
    if not task.done():
        orders.cancel(order["orderId"])
    await task
    order = await orders.settle(order["orderId"])
    assert fired and len({s["gpuId"] for s in order["segments"]}) >= 2
    gpus = {x["gpuId"] for x in order["settlements"]}
    assert len(gpus) >= 2  # both GPUs get paid for what they served
    cap = Decimal(order["capUsdc"])
    assert paid_to(ledger, "pool:") + paid_to(ledger, "provider:") + Decimal((order["refund"] or {"amountUsdc": "0"})["amountUsdc"]) == cap
    for line in order["settlements"]:
        served_cost = sum(
            Decimal(str(s["served"])) * Decimal(str(s["unitPriceUsdc"])) for s in order["segments"] if s["gpuId"] == line["gpuId"]
        )
        assert Decimal(line["amountUsdc"]) == S.floor6(served_cost)  # paid for exactly the work it served


async def test_cap_top_up_is_a_second_escrow_and_both_are_released(orders, ledger):  # noqa: F811
    req = OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=200, requests=[VWAP], bufferPct=10)
    order = await orders.create(req)
    oid = order["orderId"]
    order["capUsdc"] = S.money(Decimal(order["estimateUsdc"]) / 10)  # a tenth cannot fit the reply: it pauses
    await orders.pay(oid)
    task = asyncio.create_task(orders.execute(oid))
    assert await until(lambda: orders.get(oid)["status"] == "paused")
    new_cap = Decimal(order["estimateUsdc"]) * Decimal("1.5")
    await orders.raise_cap(oid, float(new_cap))
    await task
    order = await orders.settle(oid)
    assert order["status"] == "settled"
    assert len(order["escrows"]) == 2 and order["topUps"][0]["kind"] == "escrow"
    locked = sum(Decimal(e["amountUsdc"]) for e in order["escrows"])
    assert locked == Decimal(order["capUsdc"])  # cap + top-up = the new cap, all of it escrowed
    assert ledger.escrows == {}  # both released in the settlement
    assert [t for t in ledger.batches[0] if t.startswith("escrow:")] == ["escrow:0", "escrow:1"]
    refund = Decimal(order["refund"]["amountUsdc"])
    assert paid_to(ledger, "pool:") + paid_to(ledger, "provider:") + refund == locked


async def test_batch_rejected_falls_back_one_by_one_without_repeating(orders, ledger):  # noqa: F811
    ledger.batch = False
    order = await run(orders, OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP]))
    assert order["status"] == "settled" and ledger.batches == []
    tags = [t["tag"] for t in ledger.txs if t.get("tag")]
    assert tags[0] == "escrow:0" and len(tags) == len(set(tags))  # each step exactly once, escrow first


async def test_a_failed_step_resumes_on_retry_and_never_pays_twice(orders, ledger):  # noqa: F811
    ledger.batch = False
    ledger.fail_tag = "refund"
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP]))
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    with pytest.raises(L.LedgerError):
        await orders.settle(order["orderId"])
    landed = [t["tag"] for t in ledger.txs if t.get("tag")]
    assert "escrow:0" in landed and "refund" not in landed
    order = await orders.settle(order["orderId"])  # retry
    tags = [t["tag"] for t in ledger.txs if t.get("tag")]
    assert order["status"] == "settled" and len(tags) == len(set(tags)) and "refund" in tags


async def test_expired_escrow_is_cancelled_back_to_the_buyer(orders, ledger):  # noqa: F811
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", buyer="ALICE", maxTokens=40, requests=[VWAP]))
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    ledger.now += 10**7  # long past CancelAfter
    order = await orders.settle(order["orderId"])
    assert order["settlementNote"] == "ESCROW_EXPIRED"
    assert ledger.bal("ALICE") == Decimal("500")  # every TDX back
    assert order["charged"] == "0.000000" and order["refund"]["via"] == "EscrowCancel"


async def test_custodial_user_buyer_pays_through_api_and_settles_on_ledger(orders, ledger, monkeypatch):  # noqa: F811
    fake_api = FakeApi()
    monkeypatch.setattr(S, "TRANSPORT", httpx.MockTransport(fake_api.handler))
    ledger.balances["PROTOCOL_FEES"] = Decimal("0")
    buyer = "U_rTestUserAddress1234567890abcd"
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", buyer=buyer, maxTokens=40, requests=[VWAP]))
    await orders.pay(order["orderId"])
    assert orders.get(order["orderId"])["payment"]["kind"] == "payment"
    assert fake_api.payments[0]["memoType"] == "MS_ORDER"
    ledger.balances["PROTOCOL_FEES"] = Decimal(order["capUsdc"])  # what that api Payment delivered
    await orders.execute(order["orderId"])
    order = await orders.settle(order["orderId"])
    assert order["status"] == "settled"
    assert ledger.bal(buyer) == Decimal(order["refund"]["amountUsdc"]) and ledger.bal("PROTOCOL_FEES") == 0


# ---- pure parts ------------------------------------------------------------------------------


def test_condition_and_fulfillment_are_preimage_sha256():
    keys = L.condition_for("ABC123", "k")
    pre = bytes.fromhex(keys["fulfillment"][8:])
    assert len(pre) == 32 and keys["fulfillment"].startswith("A0228020")
    assert keys["condition"] == "A0258020" + hashlib.sha256(pre).hexdigest().upper() + "810120"
    assert L.condition_for("ABC123", "k") == keys and L.condition_for("ABC124", "k") != keys


def test_chunks_put_every_escrow_finish_first_and_hold_at_most_8():
    steps = [L.Step("pay", tag=f"p{i}") for i in range(9)] + [L.Step("finish", tag="escrow:0"), L.Step("finish", tag="escrow:1")]
    out = L.chunks(steps)
    assert [s.tag for s in out[0]][:2] == ["escrow:0", "escrow:1"]
    assert all(len(c) <= L.MAX_BATCH for c in out) and sum(map(len, out)) == len(steps)


def test_settlement_math_always_sums_to_the_cap_exactly():
    rng = random.Random(7)
    for _ in range(500):
        segs = []
        for i in range(rng.randint(1, 3)):
            segs.append({
                "gpuId": f"g{i}", "label": f"G{i}", "provider": rng.choice(["moonshift", "aws", "azure", "vast"]),
                "pool": rng.choice(["gpu-a", "gpu-b"]), "unit": "tokens",
                "served": rng.randint(0, 5000), "unitPriceUsdc": f"{rng.uniform(0.000001, 0.0003):.9f}",
            })
        cost = sum(Decimal(str(s["served"])) * Decimal(s["unitPriceUsdc"]) for s in segs)
        cap = S.money(S.ceil6(cost * Decimal(rng.choice(["0.7", "1.0", "1.1", "1.5"]))) + Decimal("0.000001"))
        order = {"capUsdc": cap, "segments": segs}
        lines = S.settlement_lines(order)  # runs S.check: raises on any mismatch
        charged = sum(Decimal(x["amountUsdc"]) for x in lines)
        assert charged <= Decimal(cap)
        assert sum(Decimal(x["toPoolUsdc"]) + Decimal(x["providerCostUsdc"]) for x in lines) + S.refund_dec(order, lines) == Decimal(cap)

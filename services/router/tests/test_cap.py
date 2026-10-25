"""Price cap: the buyer sets aside estimate x (1 + buffer); cost never exceeds it; the refund is
the cap minus the actual cost; a reclaim mid-task stays under the cap or pauses; cancel refunds
everything not spent."""

import asyncio

import pytest

from router import settle as S
from router.engine import answer_for
from router.orders import OrderCreate
from tests.test_orders import VWAP
from tests.test_resume import api, current_gpu, orders, trigger_at  # noqa: F401 (fixtures)


def charged(order):
    return sum(float(x["amountUsdc"]) for x in order["settlements"])


def refunded(order):
    """No refund transaction when nothing is left (the order stopped exactly at its cap)."""
    return float((order["refund"] or {"amountUsdc": "0"})["amountUsdc"])


async def until(predicate, seconds=10.0):
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return False


async def run(orders, req, before_execute=None):
    order = await orders.create(req)
    if before_execute:
        before_execute(order)
    await orders.pay(order["orderId"])
    await orders.execute(order["orderId"])
    return await orders.settle(order["orderId"])


@pytest.mark.parametrize("buffer", [10, 25, 50])
async def test_cost_never_exceeds_cap_and_refund_is_cap_minus_actual(orders, api, buffer):  # noqa: F811
    order = await run(orders, OrderCreate(kind="inference", mode="balanced", maxTokens=60, requests=[VWAP], bufferPct=buffer))
    assert order["status"] == "settled"
    cap = float(order["capUsdc"])
    assert cap == pytest.approx(float(order["estimateUsdc"]) * (1 + buffer / 100), abs=1e-6)
    ms_order = [p for p in api.payments if p["memoType"] == "MS_ORDER"]
    assert ms_order[0]["amount"] == order["capUsdc"]  # the cap is set aside on the ledger
    assert charged(order) <= cap + 1e-9
    assert refunded(order) == pytest.approx(cap - charged(order), abs=2e-6)
    assert order["charged"] == S.money(charged(order))


async def test_bad_buffer_is_refused(orders):  # noqa: F811
    from router.errors import RouterError

    with pytest.raises(RouterError):
        await orders.create(OrderCreate(kind="inference", maxTokens=20, requests=[VWAP], bufferPct=33))


@pytest.mark.parametrize("buffer", [10, 50])
async def test_reclaim_mid_task_stays_under_the_cap_or_pauses(orders, api, buffer):  # noqa: F811
    total = len(answer_for(VWAP)[:200])
    fired = trigger_at(orders, total // 2, lambda o: orders.reclaim(current_gpu(o), 2, "RECLAIMED"))
    order = await orders.create(OrderCreate(kind="inference", mode="cheapest", maxTokens=200, requests=[VWAP], bufferPct=buffer))
    await orders.pay(order["orderId"])
    task = asyncio.create_task(orders.execute(order["orderId"]))
    assert await until(lambda: task.done() or orders.get(order["orderId"])["status"] == "paused")
    assert fired
    live = orders.get(order["orderId"])
    assert S.spent(live) <= float(live["capUsdc"]) + 1e-9
    if not task.done():  # nothing affordable after the reclaim: paused, never over the cap
        assert live["status"] == "paused"
        orders.cancel(order["orderId"])
    await task
    order = await orders.settle(order["orderId"])
    assert order["status"] in ("settled", "cancelled")
    assert charged(order) <= float(order["capUsdc"]) + 1e-9
    assert refunded(order) == pytest.approx(float(order["capUsdc"]) - charged(order), abs=2e-6)


async def test_cap_reached_pauses_then_a_raised_cap_finishes_it(orders, api):  # noqa: F811
    req = OrderCreate(kind="inference", mode="balanced", maxTokens=200, requests=[VWAP], bufferPct=10)
    order = await orders.create(req)
    # The estimate covers maxTokens; the reply is shorter. A tenth of it cannot fit the reply.
    order["capUsdc"] = S.money(float(order["estimateUsdc"]) * 0.1)
    await orders.pay(order["orderId"])
    task = asyncio.create_task(orders.execute(order["orderId"]))
    assert await until(lambda: orders.get(order["orderId"])["status"] == "paused")
    live = orders.get(order["orderId"])
    assert S.spent(live) <= float(live["capUsdc"]) + 1e-9  # stopped at the cap, never past it
    assert live["pause"]["reason"] == "CAP_REACHED"
    new_cap = float(order["estimateUsdc"]) * 1.5
    await orders.raise_cap(order["orderId"], new_cap)
    await task
    done = await orders.settle(order["orderId"])
    assert done["status"] == "settled"
    assert done["output"][0] == "".join(answer_for(VWAP)[:200])  # one continuous reply
    assert charged(done) <= new_cap + 1e-9
    paid_in = sum(float(p["amount"]) for p in api.payments if p["memoType"] == "MS_ORDER")
    assert paid_in == pytest.approx(new_cap, abs=2e-6)  # cap + top-up = the new cap
    assert refunded(done) == pytest.approx(new_cap - charged(done), abs=2e-6)


async def test_cancel_while_paused_refunds_everything_not_spent(orders, api):  # noqa: F811
    order = await orders.create(OrderCreate(kind="inference", mode="balanced", maxTokens=200, requests=[VWAP], bufferPct=10))
    order["capUsdc"] = S.money(float(order["estimateUsdc"]) * 0.08)
    await orders.pay(order["orderId"])
    task = asyncio.create_task(orders.execute(order["orderId"]))
    assert await until(lambda: orders.get(order["orderId"])["status"] == "paused")
    orders.cancel(order["orderId"])
    result = await task
    assert result["status"] == "cancelled"
    done = await orders.settle(order["orderId"])
    assert done["status"] == "cancelled"
    cap = float(done["capUsdc"])
    assert charged(done) == pytest.approx(S.spent(done), abs=2e-6) and charged(done) <= cap + 1e-9
    assert refunded(done) == pytest.approx(cap - charged(done), abs=2e-6)


async def test_cancel_while_running_stops_and_refunds(orders, api):  # noqa: F811
    total = len(answer_for(VWAP)[:200])
    trigger_at(orders, total // 3, lambda o: orders.cancel(o["orderId"]))
    order = await run(orders, OrderCreate(kind="inference", mode="balanced", maxTokens=200, requests=[VWAP]))
    assert order["status"] == "cancelled"
    assert 0 < charged(order) < float(order["estimateUsdc"])
    assert refunded(order) == pytest.approx(float(order["capUsdc"]) - charged(order), abs=2e-6)


async def test_reclaim_with_nothing_affordable_pauses_instead_of_overspending(orders, api):  # noqa: F811
    total = len(answer_for(VWAP)[:200])
    half = total // 2
    state = {}

    def squeeze(o):
        # Leave almost no budget for the rest, then reclaim the GPU: no other GPU fits.
        unit = float(o["segments"][-1]["unitPriceUsdc"])
        o["capUsdc"] = S.money(half * unit + unit * 2)
        state["cap"] = float(o["capUsdc"])
        orders.reclaim(current_gpu(o), 1, "RECLAIMED")

    trigger_at(orders, half, squeeze)
    order = await orders.create(OrderCreate(kind="inference", mode="cheapest", maxTokens=200, requests=[VWAP]))
    await orders.pay(order["orderId"])
    task = asyncio.create_task(orders.execute(order["orderId"]))
    assert await until(lambda: orders.get(order["orderId"])["status"] == "paused")
    live = orders.get(order["orderId"])
    assert S.spent(live) <= state["cap"] + 1e-9
    orders.cancel(order["orderId"])
    await task
    done = await orders.settle(order["orderId"])
    assert done["status"] == "cancelled"
    assert charged(done) <= float(done["capUsdc"]) + 1e-9

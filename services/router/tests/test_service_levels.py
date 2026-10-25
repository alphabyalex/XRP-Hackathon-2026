"""Service levels on Moonshift's own identical GPUs: whole-job prices, distinct modes, honest deadlines."""

from __future__ import annotations

import pytest

from router import config as C
from router import optimizer as O
from router.errors import RouterError
from router.fleet import GpuView
from router.quoting import check_size

ON_DEMAND, SPOT = 0.526, 0.17358


def gpu(i: str, **kw) -> GpuView:
    base = dict(
        id=f"gpu-{i}",
        label=f"GPU-{i.upper()}",
        provider="moonshift",
        region="us-east-2",
        gpuModel="T4",
        hardware="NVIDIA T4 16GB",
        capacityType="moonshift",
        pool=f"gpu-{i}",
        priceUsdcPerHour=ON_DEMAND,
        tokensPerSec=40.0,
        interruptionRatePerHour=0.0,
        warningWindowSeconds=0.0,
        startupSeconds=0.0,
        egressPerGbUsd=0.0,
        maxConcurrent=2,
        activeJobs=0,
        queueWaitSeconds=0.0,
        bookedWindows=(),
        available=True,
        executable=True,
        fresh=True,
        offerKey=f"moonshift#us-east-2#gpu-{i}#moonshift",
        asOf="2026-10-25T00:00:00Z",
        spotUsdcPerHour=SPOT,
    )
    return GpuView(**{**base, **kw})


FLEET = [gpu("a"), gpu("b")]


def rental(hours: float, **kw) -> O.OrderSpec:
    return O.OrderSpec("rental", minutes=int(hours * 60), **kw)


def options(spec: O.OrderSpec, views=FLEET) -> dict[str, O.Choice]:
    choices, _ = O.choose_for(spec, views)
    return choices


@pytest.mark.parametrize("hours", [1, 55, 100, 200])
def test_price_scales_linearly_with_size(hours):
    one, many = options(rental(1)), options(rental(hours))
    for mode in O.MODES:
        assert many[mode].plan.cost == pytest.approx(one[mode].plan.cost * hours, rel=1e-9)


def test_whole_job_is_priced_at_each_level_rate():
    o = options(rental(55))
    assert o["cheapest"].plan.cost == pytest.approx(55 * SPOT)
    assert o["balanced"].plan.cost == pytest.approx(55 * ON_DEMAND)
    assert o["fastest"].plan.cost == pytest.approx(55 * ON_DEMAND * (1 + C.PRIORITY_PREMIUM))


def test_three_modes_differ_in_price_and_eta():
    o = options(rental(2))
    prices = {m: o[m].plan.cost for m in O.MODES}
    etas = {m: o[m].plan.eta_s for m in O.MODES}
    assert prices["cheapest"] < prices["balanced"] < prices["fastest"]
    assert etas["fastest"] < etas["balanced"] < etas["cheapest"]
    assert etas["fastest"] == pytest.approx(etas["balanced"] / 2)  # both GPUs in parallel
    assert etas["cheapest"] == pytest.approx(etas["balanced"] * (1 + C.PAUSABLE_SLOWDOWN))  # expected pauses
    assert [len(o[m].plan.parts) for m in O.MODES] == [1, 1, 2]
    assert [o[m].level["name"] for m in O.MODES] == ["Pausable", "Guaranteed", "Priority"]


def test_inference_batch_modes_differ_too():
    o = options(O.OrderSpec("inference", tokens=5000, requests=2))
    assert len({round(o[m].plan.cost, 9) for m in O.MODES}) == 3
    assert len({round(o[m].plan.eta_s, 3) for m in O.MODES}) == 3


def test_infeasible_deadline_is_flagged_not_truncated():
    o = options(rental(55, deadlineSeconds=10 * 3600))
    full = options(rental(55))
    for mode in O.MODES:
        assert o[mode].plan is not None and o[mode].deadline_met is False
        assert o[mode].plan.cost == pytest.approx(full[mode].plan.cost)  # the whole job, not 10 hours of it
        assert o[mode].plan.eta_s > 10 * 3600


def test_deadline_met_by_fastest_only():
    o = options(rental(10, deadlineSeconds=6 * 3600))
    assert [o[m].deadline_met for m in O.MODES] == [False, False, True]


def test_size_is_capped_at_what_the_fleet_finishes_in_seven_days():
    check_size(rental(336), FLEET)  # 2 GPUs x 7 days
    with pytest.raises(RouterError) as e:
        check_size(rental(337), FLEET)
    assert e.value.code == "TOO_LARGE" and "Max 336 GPU-hours" in e.value.message


def test_fastest_on_one_available_gpu_still_runs():
    o = options(rental(2), [gpu("a"), gpu("b", available=False, reason="RECLAIMED")])
    assert len(o["fastest"].plan.parts) == 1 and o["fastest"].plan.parts[0].gpu.id == "gpu-a"


def test_a_mixed_fleet_keeps_the_optimizer():
    external = gpu("x", provider="aws", spotUsdcPerHour=0.0, capacityType="spot")
    choices, plans = O.choose_for(rental(2), [*FLEET, external])
    assert plans > len(O.MODES) and choices["balanced"].level is None

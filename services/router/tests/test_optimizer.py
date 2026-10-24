import random
from collections import Counter
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from router import optimizer as O
from router.fleet import GpuView
from router.main import app
from router.quoting import OrderIn, quote, to_spec

NOW = datetime(2026, 10, 24, 22, 0, tzinfo=UTC)


def gv(id, **kw):
    base = dict(
        id=id,
        label=id.upper(),
        provider="moonshift",
        region="us-east-2",
        gpuModel="T4",
        hardware="T4",
        capacityType="moonshift",
        pool="gpu-a",
        priceUsdcPerHour=0.25,
        tokensPerSec=40.0,
        interruptionRatePerHour=0.0,
        warningWindowSeconds=20.0,
        startupSeconds=1.0,
        egressPerGbUsd=0.0,
        maxConcurrent=2,
        activeJobs=0,
        queueWaitSeconds=0.0,
        bookedWindows=(),
        available=True,
        executable=True,
        fresh=True,
        offerKey=f"k#{id}",
        asOf="2026-10-24T22:00:00Z",
    )
    base.update(kw)
    return GpuView(**base)


FLEET = [
    gv("ms-a", pool="gpu-a"),
    gv("ms-b", pool="gpu-b"),
    gv(
        "aws-spot",
        provider="aws",
        capacityType="spot",
        priceUsdcPerHour=0.20,
        interruptionRatePerHour=0.0001,
        warningWindowSeconds=120,
        startupSeconds=3,
        egressPerGbUsd=0.09,
    ),
    gv(
        "aws-od",
        provider="aws",
        capacityType="on-demand",
        priceUsdcPerHour=1.16,
        tokensPerSec=90,
        startupSeconds=3,
        warningWindowSeconds=0,
        egressPerGbUsd=0.09,
        pool="gpu-b",
    ),
    gv(
        "az-spot",
        provider="azure",
        capacityType="spot",
        priceUsdcPerHour=0.17,
        interruptionRatePerHour=0.0004,
        warningWindowSeconds=30,
        startupSeconds=4,
        egressPerGbUsd=0.087,
    ),
    gv(
        "vast",
        provider="vast",
        capacityType="marketplace",
        priceUsdcPerHour=0.46,
        tokensPerSec=140,
        interruptionRatePerHour=0.00002,
        warningWindowSeconds=0,
        startupSeconds=5,
        egressPerGbUsd=0.02,
        maxConcurrent=1,
        pool="gpu-b",
    ),
]


def pick(order, fleet=FLEET):
    return O.choose(O.enumerate_plans(order, fleet), order)


def ids(choice):
    return sorted(p.gpu.id for p in choice.plan.parts)


def random_order(rng):
    if rng.random() < 0.5:
        return O.OrderSpec("rental", minutes=rng.choice([5, 10, 15, 30, 60, 120]))
    n = rng.choice([1, 1, 2, 4, 8, 20])
    return O.OrderSpec("inference", tokens=n * rng.choice([64, 256, 512, 2048]), requests=n)


@pytest.mark.parametrize("seed", range(40))
def test_mode_ordering_holds(seed):
    rng = random.Random(seed)
    fleet = [replace(g, queueWaitSeconds=rng.choice([0, 0, 0, 30, 120])) for g in FLEET]
    order = random_order(rng)
    c = pick(order, fleet)
    cheap, bal, fast = c["cheapest"].plan, c["balanced"].plan, c["fastest"].plan
    assert cheap.cost <= fast.cost + 1e-12  # cheapest never costs more than fastest
    assert fast.eta_s <= cheap.eta_s + 1e-9  # fastest never finishes later than cheapest
    assert cheap.cost - 1e-12 <= bal.cost <= fast.cost + 1e-12  # balanced lies between on cost
    assert fast.eta_s - 1e-9 <= bal.eta_s <= cheap.eta_s + 1e-9  # and on time


def test_same_inputs_same_plans():
    order = O.OrderSpec("inference", tokens=1200, requests=4)
    a, b = pick(order), pick(order)
    for m in O.MODES:
        assert a[m].plan.signature == b[m].plan.signature


def test_booked_window_pushes_job_elsewhere():
    order = O.OrderSpec("rental", minutes=30)
    assert ids(pick(order)["cheapest"]) == ["az-spot"]
    booked = [replace(g, bookedWindows=((60.0, 7200.0),)) if g.id == "az-spot" else g for g in FLEET]
    # Without a deadline, waiting for the window to clear is free, so Cheapest may still wait for it.
    waited = pick(order, booked)["cheapest"]
    if "az-spot" in ids(waited):
        assert waited.plan.eta_s > 7200
    # With a deadline, or in Balanced and Fastest, the booking pushes the job to other GPUs.
    c = pick(replace(order, deadlineSeconds=3600), booked)
    for m in O.MODES:
        assert "az-spot" not in ids(c[m]) and c[m].plan.eta_s <= 3600
    assert "az-spot" not in ids(pick(order, booked)["balanced"])


def test_deadline_excludes_slow_plans():
    order = O.OrderSpec("rental", minutes=60)
    slow = pick(order)["cheapest"].plan
    assert slow.eta_s > 1800
    rushed = pick(replace(order, deadlineSeconds=1800))["cheapest"].plan
    assert rushed.eta_s <= 1800 and len(rushed.parts) >= 2
    impossible = pick(replace(order, deadlineSeconds=60))
    assert impossible["cheapest"].plan is None and impossible["cheapest"].reason == "NO_PLAN_MEETS_DEADLINE_AND_BUDGET"
    assert impossible["fastest"].plan is not None and impossible["fastest"].deadline_met is False


def test_budget_caps_every_mode():
    order = O.OrderSpec("rental", minutes=30, budgetUsdc=0.12)
    c = pick(order)
    assert all(c[m].plan.cost <= 0.12 for m in O.MODES)


def test_interruptible_gpu_wins_cheapest_after_overhead():
    order = O.OrderSpec("rental", minutes=60)
    plan = pick(order)["cheapest"].plan
    part = plan.parts[0]
    assert part.gpu.id == "az-spot" and part.p_interrupt > 0 and part.cost > 0.17  # overhead is included
    assert plan.cost < 0.25  # still cheaper than the guaranteed Moonshift T4 for the hour
    # Make interruptions frequent enough and the guaranteed GPU wins instead.
    risky = [replace(g, interruptionRatePerHour=40.0) if g.id in ("az-spot", "aws-spot") else g for g in FLEET]
    assert "az-spot" not in ids(pick(order, risky)["cheapest"])


def test_resume_cost_is_never_zero():
    order = O.OrderSpec("rental", minutes=30)
    for g in FLEET:
        assert O.part_metrics(g, 6, order, FLEET, O.Params()).resume_s > 0


def test_stale_or_non_executable_offers_are_never_chosen():
    stale = replace(FLEET[4], fresh=False, degraded=False, available=False, reason="STALE_PRICE")
    not_exec = replace(FLEET[2], executable=False)
    fleet = [g for g in FLEET if g.id not in ("az-spot", "aws-spot")] + [stale, not_exec]
    for order in (O.OrderSpec("rental", minutes=30), O.OrderSpec("inference", tokens=800, requests=4)):
        for m in O.MODES:
            assert not {"az-spot", "aws-spot"} & set(ids(pick(order, fleet)[m]))


def test_degraded_offer_is_usable_but_penalized():
    order = O.OrderSpec("rental", minutes=30)
    deg = replace(FLEET[4], fresh=False, degraded=True)
    fresh_part = O.part_metrics(FLEET[4], 6, order, FLEET, O.Params())
    deg_part = O.part_metrics(deg, 6, order, FLEET, O.Params())
    assert deg_part.cost > fresh_part.cost and deg_part.eta_s > fresh_part.eta_s


def test_cheaper_offer_on_another_provider_wins_when_executable():
    order = O.OrderSpec("rental", minutes=30)
    gcp = gv(
        "gcp-spot",
        provider="gcp",
        capacityType="spot",
        priceUsdcPerHour=0.10,
        interruptionRatePerHour=0.0004,
        warningWindowSeconds=30,
        startupSeconds=4,
        egressPerGbUsd=0.12,
        executable=False,
    )
    assert ids(pick(order, [*FLEET, gcp])["cheapest"]) == ["az-spot"]
    assert ids(pick(order, [*FLEET, replace(gcp, executable=True)])["cheapest"]) == ["gcp-spot"]


def test_cross_provider_egress_can_flip_the_choice():
    order = O.OrderSpec("rental", minutes=60)
    # Two spot GPUs, same price and risk; only one has a same-provider fallback (no egress on resume).
    a = gv(
        "x-spot",
        provider="xcloud",
        capacityType="spot",
        priceUsdcPerHour=0.30,
        interruptionRatePerHour=0.5,
        warningWindowSeconds=30,
        egressPerGbUsd=0.0,
    )
    b = gv(
        "y-spot",
        provider="ycloud",
        capacityType="spot",
        priceUsdcPerHour=0.30,
        interruptionRatePerHour=0.5,
        warningWindowSeconds=30,
        egressPerGbUsd=0.0,
    )
    fallback_y = gv("y-od", provider="ycloud", capacityType="on-demand", priceUsdcPerHour=0.29, warningWindowSeconds=0)
    expensive = gv("z", provider="zcloud", priceUsdcPerHour=5.0)
    cheap_egress = [a, b, fallback_y, expensive]
    # With no egress price, the cheapest is the on-demand fallback itself; compare the two spot parts.
    pa = O.part_metrics(a, 12, order, cheap_egress, O.Params())
    pb = O.part_metrics(b, 12, order, cheap_egress, O.Params())
    assert pa.egress_cost == 0 and pb.egress_cost == 0
    # Now x's data leaves xcloud at $0.30/GB on a cross-provider resume; y resumes inside ycloud.
    a2 = replace(a, egressPerGbUsd=0.30)
    b2 = replace(b, egressPerGbUsd=0.30)
    fleet = [a2, b2, fallback_y, expensive]
    pa2 = O.part_metrics(a2, 12, order, fleet, O.Params())
    pb2 = O.part_metrics(b2, 12, order, fleet, O.Params())
    assert pa2.egress_cost > 0 and pb2.egress_cost == 0
    assert pb2.cost < pa2.cost
    only_spot = O.OrderSpec("rental", minutes=60, constraints=O.Constraints(excludeProviders=()))
    plans = [
        p
        for p in O.enumerate_plans(only_spot, fleet)
        if len(p.parts) == 1 and p.parts[0].gpu.id in ("x-spot", "y-spot")
    ]
    assert min(plans, key=lambda p: p.cost).parts[0].gpu.id == "y-spot"


def test_single_streamed_reply_is_never_split():
    order = O.OrderSpec("inference", tokens=2000, requests=1)
    plans = O.enumerate_plans(order, FLEET)
    assert plans and all(len(p.parts) == 1 for p in plans)


def test_constraints_filter_candidates():
    order = O.OrderSpec("rental", minutes=30, constraints=O.Constraints(gpuModel="T4", excludeProviders=("azure",)))
    for m in O.MODES:
        parts = pick(order)[m].plan.parts
        assert all(p.gpu.gpuModel == "T4" and p.gpu.provider != "azure" for p in parts)


def test_quote_shape_matches_contract_and_counts_alternatives():
    import json

    from router import config as C

    contract = json.loads((C.CONTRACTS_DIR / "quote.json").read_text())["response"]
    spec = to_spec(OrderIn(kind="inference", tokens=1200, requests=4))
    body, _ = quote(spec, FLEET, Counter({"aws": 12, "oracle": 3}), "2026-10-24T22:00:00Z", NOW)
    assert set(body) == set(contract)
    assert body["alternativesConsidered"] == {"aws": 12, "oracle": 3}
    part_keys = set(contract["options"]["cheapest"]["parts"][0])
    for m in O.MODES:
        assert body["options"][m]["feasible"]
        assert part_keys <= set(body["options"][m]["parts"][0])
    again, _ = quote(spec, FLEET, Counter({"aws": 12, "oracle": 3}), "2026-10-24T22:00:00Z", NOW)
    assert again == body


def test_http_quote_all_three_modes():
    with TestClient(app) as client:
        r = client.post("/quote", json={"kind": "rental", "minutes": 30})
        assert r.status_code == 200
        body = r.json()
        assert set(body["options"]) == {"cheapest", "balanced", "fastest"}
        assert body["why"] is None  # BEDROCK_EXPLAIN off
        assert sum(body["alternativesConsidered"].values()) >= 30
        assert client.post("/quote", json={"kind": "rental"}).status_code == 422


def test_bedrock_why_keeps_only_sentences_with_known_numbers(monkeypatch):
    from router import config as C
    from router import why

    spec = to_spec(OrderIn(kind="rental", minutes=30))
    body, _ = quote(spec, FLEET, Counter({"aws": 12}), "2026-10-24T22:00:00Z", NOW)
    cheap = body["options"]["cheapest"]
    reply = (
        f'{{"text": "Cheapest runs on {cheap["parts"][0]["label"]} for {cheap["priceUsdc"]} USDC. '
        f"Fastest finishes in {body['options']['fastest']['etaSeconds']} seconds. "
        'It also saves 99.5 percent forever."}'
    )

    class FakeBedrock:
        def converse(self, **kw):
            assert "Use only the numbers given" in kw["system"][0]["text"]
            return {"output": {"message": {"content": [{"text": reply}]}}}

    monkeypatch.setattr(C, "BEDROCK_EXPLAIN", True)
    text = why.explain(body, client=lambda *a, **k: FakeBedrock())
    assert text and cheap["priceUsdc"] in text and "99.5" not in text
    monkeypatch.setattr(C, "BEDROCK_EXPLAIN", False)
    assert why.explain(body, client=lambda *a, **k: FakeBedrock()) is None

"""FLEET_SOURCE=own: only real GPU-A is configured, with a live market benchmark."""

from __future__ import annotations

from router import config as C
from router.catalog import Availability, iso, make_offer, now_utc
from router.fleet import load_entries


def offer(provider: str, instance: str, capacity: str, price: float, status: str = "likely", model: str = "T4"):
    return make_offer(
        provider=provider,
        region="us-east-1",
        instance_type=instance,
        gpu_model=model,
        gpu_count=1,
        capacity_type=capacity,
        price_per_hour_usd=price,
        price_source="live",
        as_of=iso(now_utc()),
        availability=Availability(status),
    )


def catalog(*offers):
    return {o.key: o for o in offers}


def test_own_fleet_is_only_moonshift_gpus(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog(offer("aws", "g4dn.xlarge", "on-demand", 0.526)))
    assert [(e.id, e.label, e.offer.provider) for e in entries] == [("gpu-a", "GPU-A", "moonshift")]


def test_price_is_own_lease_policy_and_market_and_aws_are_comparisons(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(
        catalog(
            offer("aws", "g4dn.xlarge", "on-demand", 0.526),
            offer("gcp", "n1-standard-4+t4", "on-demand", 0.54),
            offer("azure", "NC4as_T4_v3", "spot", 0.149),  # interruptible: not a benchmark for dedicated GPUs
            offer("vast", "1x RTX 4090", "on-demand", 0.30, model="RTX 4090"),  # another GPU
            offer("lambda", "t4", "on-demand", 0.40, status="none"),  # no capacity
        ),
        {"T4": {"pricePerGpuHourUsd": 0.55, "asOf": iso(now_utc()), "checkedAt": iso(now_utc()),
                "source": "GPU Economy", "offerKey": "gpu-economy#t4"}},
    )
    for e in entries:
        assert e.offer.pricePerHourUsd == C.OWN_RATE_USD_PER_HOUR
        assert e.offer.price_per_hour_usdc() == C.OWN_RATE_USD_PER_HOUR
        assert e.benchmark and e.benchmark["source"] == "Akash lease plus margin"
        assert e.benchmark["marketComparison"]["offerKey"] == "gpu-economy#t4"
        assert e.benchmark["awsComparison"]["offerKey"] == "aws#us-east-1#g4dn.xlarge#on-demand"


def test_configured_own_price_does_not_depend_on_an_external_comparison(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog())
    assert all(e.offer.pricePerHourUsd == C.OWN_RATE_USD_PER_HOUR and e.benchmark["marketComparison"] is None and e.offerFound for e in entries)


def test_gpus_apps_api_does_not_list_are_not_offered(monkeypatch):
    from router.fleet import FleetState

    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog(offer("aws", "g4dn.xlarge", "on-demand", 0.526)),
        {"T4": {"pricePerGpuHourUsd": 0.55, "asOf": iso(now_utc()), "checkedAt": iso(now_utc()),
                "source": "GPU Economy", "offerKey": "gpu-economy#t4"}})
    state = FleetState(unlisted={"gpu-a"})
    views = {e.id: state.view(e, now_utc()) for e in entries}
    assert views["gpu-a"].available is False and views["gpu-a"].reason == "NOT_LISTED"


def test_new_gpu_needs_its_own_verified_lease_cost(monkeypatch):
    monkeypatch.delenv("GPU_B_LEASE_USD_PER_HOUR", raising=False)
    monkeypatch.delenv("GPU_B_PRICE_UPDATED_AT", raising=False)
    assert C.own_rental_policy("gpu-b") is None
    monkeypatch.setenv("GPU_B_LEASE_USD_PER_HOUR", "0.230346")
    monkeypatch.setenv("GPU_B_PRICE_UPDATED_AT", iso(now_utc()))
    policy = C.own_rental_policy("gpu-b")
    assert policy["pricePerGpuHourUsd"] == round(0.230346 * 1.25, 6)
    assert policy["source"] == "Akash lease plus margin"


def test_invalid_lease_cost_never_becomes_a_zero_dollar_offer(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    monkeypatch.setenv("GPU_A_LEASE_USD_PER_HOUR", "nan")
    entries = load_entries(catalog())
    assert not entries[0].offerFound
    assert entries[0].offer.pricePerHourUsd == 0

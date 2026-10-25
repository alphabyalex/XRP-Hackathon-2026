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


def test_price_is_gpu_economy_median_and_aws_is_comparison_only(monkeypatch):
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
        assert e.offer.pricePerHourUsd == 0.55
        assert e.offer.price_per_hour_usdc() == 0.55
        assert e.benchmark and e.benchmark["offerKey"] == "gpu-economy#t4"
        assert e.benchmark["awsComparison"]["offerKey"] == "aws#us-east-1#g4dn.xlarge#on-demand"


def test_gpu_is_unpriced_when_the_market_has_no_live_offer(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog())
    assert all(e.offer.pricePerHourUsd == 0 and e.benchmark is None and not e.offerFound for e in entries)


def test_gpus_apps_api_does_not_list_are_not_offered(monkeypatch):
    from router.fleet import FleetState

    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog(offer("aws", "g4dn.xlarge", "on-demand", 0.526)),
        {"T4": {"pricePerGpuHourUsd": 0.55, "asOf": iso(now_utc()), "checkedAt": iso(now_utc()),
                "source": "GPU Economy", "offerKey": "gpu-economy#t4"}})
    state = FleetState(unlisted={"gpu-a"})
    views = {e.id: state.view(e, now_utc()) for e in entries}
    assert views["gpu-a"].available is False and views["gpu-a"].reason == "NOT_LISTED"

"""FLEET_SOURCE=own: tasks run only on GPU-A and GPU-B, priced from the market benchmark."""

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
        price_source="fixture",
        as_of=iso(now_utc()),
        availability=Availability(status),
    )


def catalog(*offers):
    return {o.key: o for o in offers}


def test_own_fleet_is_only_moonshift_gpus(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog(offer("aws", "g4dn.xlarge", "on-demand", 0.526)))
    assert [(e.id, e.label, e.offer.provider) for e in entries] == [("gpu-a", "GPU-A", "moonshift"), ("gpu-b", "GPU-B", "moonshift")]


def test_price_is_the_cheapest_on_demand_offer_for_the_same_gpu(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(
        catalog(
            offer("aws", "g4dn.xlarge", "on-demand", 0.526),
            offer("gcp", "n1-standard-4+t4", "on-demand", 0.54),
            offer("azure", "NC4as_T4_v3", "spot", 0.149),  # interruptible: not a benchmark for dedicated GPUs
            offer("vast", "1x RTX 4090", "on-demand", 0.30, model="RTX 4090"),  # another GPU
            offer("lambda", "t4", "on-demand", 0.40, status="none"),  # no capacity
        )
    )
    for e in entries:
        assert e.offer.pricePerHourUsd == 0.526
        assert e.offer.price_per_hour_usdc() == 0.526  # no margin on our own GPUs
        assert e.benchmark and e.benchmark["offerKey"] == "aws#us-east-1#g4dn.xlarge#on-demand"


def test_listed_price_when_the_market_has_no_offer(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    entries = load_entries(catalog())
    assert all(e.offer.pricePerHourUsd == 0.526 and e.benchmark is None for e in entries)

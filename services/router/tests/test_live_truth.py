"""Production fleets never derive availability or prices from development fixtures."""

from __future__ import annotations

import httpx
import pytest

from router import config as C
from router import optimizer as O
from router.catalog import iso, now_utc
from router.collectors import run
from router.collectors.aws_public import ON_DEMAND_BASE, SPOT_URL
from router.collectors.base import CollectContext
from router.service import Service


def public_feed(request: httpx.Request) -> httpx.Response:
    if str(request.url) == SPOT_URL:
        return httpx.Response(200, json={"config": {"regions": [{"region": "us-east-2", "instanceTypes": [
            {"sizes": [{"size": "g4dn.xlarge", "valueColumns": [
                {"name": "linux", "prices": {"USD": "0.17"}},
                {"name": "mswin", "prices": {"USD": "0.23"}},
            ]}]}]}]}})
    assert str(request.url).startswith(ON_DEMAND_BASE)
    return httpx.Response(200, json={"manifest": {"hawkFilePublicationDate": "2026-10-25T01:00:00Z"},
        "regions": {"US East (Ohio)": {"rate": {"Instance Type": "g4dn.xlarge", "price": "0.526",
            "Operating System": "Linux", "Pre Installed S/W": "NA"}}}})


def live_service(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    monkeypatch.setattr(C, "PRICE_SOURCES", "aws_public")
    service = Service()
    service.economy_rates = {"T4": {"pricePerGpuHourUsd": 0.55, "asOf": iso(now_utc()),
        "checkedAt": iso(now_utc()), "source": "GPU Economy", "offerKey": "gpu-economy#t4"}}
    service.collect(ctx=CollectContext(transport=httpx.MockTransport(public_feed)))
    return service


def test_public_aws_feed_needs_no_credentials_and_keeps_real_provenance(monkeypatch):
    service = live_service(monkeypatch)
    assert service.errors == {}
    assert {offer.priceSource for offer in service.offers.values()} == {"live"}
    spot = service.offers["aws#us-east-2#g4dn.xlarge#spot"]
    assert spot.pricePerHourUsd == 0.17 and spot.extra["source"] == SPOT_URL
    assert spot.extra["updatedAt"] == spot.asOf
    on_demand = service.offers["aws#us-east-2#g4dn.xlarge#on-demand"]
    assert on_demand.pricePerHourUsd == 0.526
    assert on_demand.extra["publishedAt"] == "2026-10-25T01:00:00Z"
    assert [entry.id for entry in service.entries] == ["gpu-a"]
    entry = service.entries[0]
    assert "Akash" in entry.hardware and entry.offer.region == "akash"
    assert entry.benchmark["awsComparison"]["spotPricePerGpuHourUsd"] == 0.17
    assert entry.offer.priceSource == "live" and entry.offer.pricePerHourUsd == 0.55


def test_stored_fixture_prices_cannot_become_live_benchmarks(monkeypatch):
    fixture_service = Service()
    fixture_service.collect(ctx=CollectContext())
    saved = list(fixture_service.offers.values())
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    service = Service()
    service.load_catalog(saved)
    assert service.offers == {}
    assert not service.entries[0].offerFound
    assert service.entries[0].offer.pricePerHourUsd == 0
    assert not service.views()[0].available


async def test_live_availability_requires_both_health_and_real_compute_worker(monkeypatch):
    service = live_service(monkeypatch)
    assert not service.views()[0].available
    assert service.catalog(provider="moonshift") == []

    def health(request):
        if request.url.path == "/gpus-health":
            return httpx.Response(200, json=[{"gpuId": "gpu-a", "ok": True}])
        if request.url.path == "/gpus":
            return httpx.Response(200, json=[{"id": "gpu-a", "state": "READY", "simulated": False}])
        return httpx.Response(200, json=[])

    await service.state.refresh_compute(service.entries, httpx.MockTransport(health))
    assert service.views()[0].available
    assert len(service.catalog(provider="moonshift")) == 1
    service.state._listing_fetched = None
    service.state._compute_fetched = None
    await service.state.refresh_compute(service.entries, httpx.MockTransport(lambda request: httpx.Response(503)))
    assert not service.views()[0].available
    assert service.catalog(provider="moonshift") == []


def test_public_feed_failure_returns_no_fixture_fallback(monkeypatch):
    monkeypatch.setattr(C, "FLEET_SOURCE", "own")
    monkeypatch.setattr(C, "PRICE_SOURCES", "aws_public")
    offers, errors = run(ctx=CollectContext(transport=httpx.MockTransport(lambda request: httpx.Response(404))))
    assert offers == [] and set(errors) == {"aws_public"}


@pytest.mark.parametrize("source, child", [("aws_spot", "aws_spot_price"), ("aws_on_demand", "aws_pricing")])
def test_collector_name_enables_its_live_child_source(monkeypatch, source, child):
    monkeypatch.setattr(C, "PRICE_SOURCES", source)
    assert C.live_source(child)


def test_local_python_service_urls_use_ipv4_loopback():
    assert C.service_url("http://localhost:5000/") == "http://127.0.0.1:5000"
    assert C.service_url("https://compute.example/v1/") == "https://compute.example/v1"
    assert C.service_url("http://localhost.example:5000/") == "http://localhost.example:5000"


async def test_shared_gpu_economy_snapshot_is_cached_and_aws_does_not_set_rental_rate(monkeypatch):
    service = live_service(monkeypatch)
    requests = []

    def feed(request):
        requests.append(request.url.path)
        return httpx.Response(200, json={"source": {"name": "GPU Economy"}, "sourceUpdatedAt": iso(now_utc()),
            "checkedAt": iso(now_utc()), "stale": False,
            "gpus": [{"id": "t4", "name": "NVIDIA T4", "rentalUsdPerHour": "0.550000"}]})

    await service.refresh_economy(httpx.MockTransport(feed))
    service.state.healthy_pools = {"gpu-a"}
    # Our rate is the lease plus margin, not the market median; with no live AWS pair every mode pays it.
    monkeypatch.setattr(O, "aws_spot_ratio", lambda: None)
    for _ in range(50):
        choices, _ = O.choose_for(O.OrderSpec("rental", minutes=60), service.views())
        assert {round(choice.plan.cost, 6) for choice in choices.values()} == {C.OWN_RATE_USD_PER_HOUR}
        assert {choice.level["rateUsdcPerGpuHour"] for choice in choices.values()} == {C.OWN_RATE_USD_PER_HOUR}
        # Pausable runs longer end to end.
        assert choices["cheapest"].plan.eta_s > choices["balanced"].plan.eta_s
    # With a live AWS spot / on-demand pair the three modes differ.
    monkeypatch.setattr(O, "aws_spot_ratio", lambda: 0.5)
    choices, _ = O.choose_for(O.OrderSpec("rental", minutes=60), service.views())
    rates = {m: c.level["rateUsdcPerGpuHour"] for m, c in choices.items()}
    full = C.OWN_RATE_USD_PER_HOUR
    assert rates == {"cheapest": round(full * 0.5, 6), "balanced": round(full * 0.75, 6), "fastest": full}
    await service.refresh_economy(httpx.MockTransport(feed))
    assert requests == ["/gpu-prices"]
    assert service.entries[0].benchmark["source"] == "GPU Economy"


async def test_stale_gpu_economy_snapshot_disables_pricing_without_aws_fallback(monkeypatch):
    service = live_service(monkeypatch)
    await service.refresh_economy(httpx.MockTransport(lambda request: httpx.Response(200,
        json={"source": {"name": "GPU Economy"}, "sourceUpdatedAt": iso(now_utc()),
              "checkedAt": iso(now_utc()), "stale": True, "gpus": []})))
    assert service.economy_rates == {}
    assert not service.entries[0].offerFound and service.entries[0].offer.pricePerHourUsd == 0


async def test_order_pin_rejects_unknown_or_offline_gpu_and_never_replans_onto_another(monkeypatch, tmp_path):
    from router.errors import RouterError
    from router.orders import OrderCreate, Orders
    from router.state import SqliteState

    service = live_service(monkeypatch)

    def health(request):
        if request.url.path == "/gpus-health":
            return httpx.Response(200, json=[{"gpuId": "gpu-a", "ok": True}])
        if request.url.path == "/gpus":
            return httpx.Response(200, json=[{"id": "gpu-a", "state": "READY", "simulated": False}])
        return httpx.Response(200, json=[])

    orders = Orders(service, SqliteState(tmp_path / "orders.db"))
    orders.compute_transport = httpx.MockTransport(health)
    request = {"kind": "inference", "requests": [[{"role": "user", "content": "Hi"}]], "maxTokens": 10}
    with pytest.raises(RouterError) as error:
        await orders.create(OrderCreate(**request, gpuId="gpu-b"))
    assert error.value.code == "UNKNOWN_GPU"
    order = await orders.create(OrderCreate(**request, gpuId="gpu-a"))
    assert {part["gpuId"] for part in order["plan"]["parts"]} == {"gpu-a"}
    assert order["constraints"]["gpuId"] == "gpu-a"
    with pytest.raises(RouterError) as error:
        await orders._next_gpu(order, service.entries[0], O.OrderSpec("inference", tokens=10))
    assert error.value.code == "GPU_OFFLINE"
    await orders.release(order["orderId"])
    service.state.compute_offline = {"gpu-a"}
    with pytest.raises(RouterError) as error:
        await orders.create(OrderCreate(**request, gpuId="gpu-a"))
    assert error.value.code == "GPU_OFFLINE"

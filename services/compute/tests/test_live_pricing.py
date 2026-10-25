"""Live-price protocol tests use explicit fixtures and never reach a GPU or ledger."""
from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from compute import router as router_module
from compute import scheduler as scheduler_module
from compute.config import Settings
from compute.main import create_app
from compute.models import ComputeError
from compute.pricing import RateClient
from compute.providers import Completion, VllmProvider


def catalog(rate="0.550000", age_seconds=0):
    updated = (datetime.now(UTC) - timedelta(seconds=age_seconds)).isoformat()
    return {"gpus": [{"id": "gpu-a", "status": "serving", "prices": {
        "rentalUsdPerHour": rate, "rental": {"usdPerHour": rate, "updatedAt": updated, "source": "Akash lease plus margin", "priceBasis": "akash_lease_plus_margin"},
        "economy": {"usdPerHour": "0.550000", "updatedAt": updated},
    }}]}


def rate_client(handler):
    return RateClient("http://old-pricing", 60, 3, False, api_url="http://api",
                      internal_api_key="test-internal-key", transport=httpx.MockTransport(handler))


def test_live_rate_uses_authenticated_catalog_and_caches_published_rate():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/catalog/gpus"
        assert request.headers["X-MS-Internal-Key"] == "test-internal-key"
        return httpx.Response(200, json=catalog())

    async def run():
        rates = rate_client(handler)
        first = await rates.get("gpu-a")
        second = await rates.get("gpu-a")
        assert first == second
        assert first.hourly_usd == Decimal("0.550000")
        assert first.source == "Akash lease plus margin" and first.updated_at
        assert first.base_fee == first.input_per_mtok == first.output_per_mtok == 0

    asyncio.run(run())
    assert len(requests) == 1


@pytest.mark.parametrize("body", [
    {"gpus": []}, catalog(None), catalog("-1"), catalog("NaN"),
    catalog(age_seconds=-600),
])
def test_missing_or_invalid_live_prices_never_become_default_token_rates(body):
    async def run():
        with pytest.raises(ComputeError) as failure:
            await rate_client(lambda request: httpx.Response(200, json=body)).get("gpu-a")
        assert failure.value.code == "PRICING_UNAVAILABLE"
        assert failure.value.status_code == 503

    asyncio.run(run())


def test_unconfigured_or_failed_catalog_does_not_fall_back():
    async def run():
        for rates in [RateClient("http://old-pricing", 60, 3, False),
                      rate_client(lambda request: httpx.Response(503))]:
            with pytest.raises(ComputeError, match="No request was started"):
                await rates.get("gpu-a")

    asyncio.run(run())


def live_app(tmp_path):
    settings = replace(Settings.from_env(), mock=False, api_url="", state_dir=tmp_path,
                       vllm_url="http://worker", gpu_b_vllm_url="", gpu_nodes=("gpu-a",))
    return create_app(settings)


class RecordedProvider(VllmProvider):
    calls = 0

    def __init__(self):
        super().__init__("http://worker", 3, transport=httpx.MockTransport(lambda request: httpx.Response(200,
            json={"data": [{"id": "Qwen/Qwen2.5-1.5B-Instruct"}]})))

    async def complete(self, **kwargs):
        self.calls += 1
        return Completion(content="Explicit protocol fixture", input_tokens=500, output_tokens=20,
                          model="Qwen/Qwen2.5-1.5B-Instruct")


class NoRate:
    async def get(self, gpu_id):
        raise AssertionError("A prepaid reservation must not fetch or charge public rates")


def test_real_completion_uses_live_hourly_price_and_measured_request_time(tmp_path, monkeypatch):
    app = live_app(tmp_path)
    provider = RecordedProvider()
    app.state.router.providers["gpu-a"] = provider
    app.state.router.rates = rate_client(lambda request: httpx.Response(200, json=catalog()))
    ticks = iter([100.0, 102.0])
    # Replace this module's clock object without altering asyncio's monotonic clock.
    monkeypatch.setattr(router_module, "time", SimpleNamespace(monotonic=lambda: next(ticks), time=time.time))
    with TestClient(app) as client:
        response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "DEV"},
                               json={"messages": [{"role": "user", "content": "Hello"}]})
    assert response.status_code == 200
    metadata = response.json()["x_ms"]
    assert metadata["charge"] == "0.000306"
    assert metadata["measured_runtime_seconds"] == 2
    assert metadata["hourly_usd"] == "0.550000"
    assert metadata["charge_basis"] == "live_hourly_rate_times_measured_request_runtime"
    assert metadata["simulated"] is False and provider.calls == 1


def test_missing_price_rejects_before_provider_execution_or_usage(tmp_path):
    app = live_app(tmp_path)
    provider = RecordedProvider()
    app.state.router.providers["gpu-a"] = provider
    app.state.router.rates = rate_client(lambda request: httpx.Response(503))
    with TestClient(app) as client:
        response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "DEV"},
                               json={"messages": [{"role": "user", "content": "Hello"}]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PRICING_UNAVAILABLE"
    assert provider.calls == 0
    assert not app.state.scheduler.worker("gpu-a")._inflight


def test_active_prepaid_booking_stays_zero_and_never_reads_public_rates(tmp_path):
    app = live_app(tmp_path)
    app.state.router.providers["gpu-a"] = RecordedProvider()
    app.state.router.rates = NoRate()
    now = datetime.now(UTC)
    with TestClient(app) as client:
        booked = client.post("/bookings", headers={"X-MS-Internal-Key": app.state.settings.internal_api_key},
                             json={"gpu_id": "gpu-a", "slot_start": (now-timedelta(seconds=1)).isoformat(),
                                   "slots": 1, "redemption_id": "prepaid-reservation", "holder": "ALICE"})
        assert booked.status_code == 200
        response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "ALICE", "X-MS-Booking": "prepaid-reservation"},
                               json={"messages": [{"role": "user", "content": "Hello"}]})
    assert response.status_code == 200
    assert response.json()["x_ms"]["charge"] == "0.000000"
    assert response.json()["x_ms"]["charge_basis"] == "prepaid_booking"


def test_missing_wrong_owner_and_expired_bookings_cannot_become_public_requests(tmp_path, monkeypatch):
    app = live_app(tmp_path)
    provider = RecordedProvider()
    app.state.router.providers["gpu-a"] = provider
    app.state.router.rates = NoRate()
    now = datetime.now(UTC)
    with TestClient(app) as client:
        booked = client.post("/bookings", headers={"X-MS-Internal-Key": app.state.settings.internal_api_key},
                             json={"gpu_id": "gpu-a", "slot_start": (now-timedelta(seconds=1)).isoformat(),
                                   "slots": 1, "redemption_id": "owned-reservation", "holder": "ALICE"})
        assert booked.status_code == 200
        for buyer, booking in [("ALICE", "missing"), ("BOB", "owned-reservation"), ("ALICE", " ")]:
            response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": buyer, "X-MS-Booking": booking},
                                   json={"messages": [{"role": "user", "content": "Hello"}]})
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "BOOKING_NOT_FOUND"
        monkeypatch.setattr(scheduler_module, "utc_now", lambda: now+timedelta(minutes=10))
        expired = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "ALICE", "X-MS-Booking": "owned-reservation"},
                              json={"messages": [{"role": "user", "content": "Hello"}]})
        assert expired.status_code == 404
    assert provider.calls == 0


def test_own_policy_accepts_point_two_while_external_median_is_point_five_five():
    data = catalog("0.200000", age_seconds=72 * 3600)
    # A configured rental policy has no invented market-feed expiry.
    async def run():
        for comparison in [data["gpus"][0]["prices"]["economy"], None]:
            data["gpus"][0]["prices"]["economy"] = comparison
            rate = await rate_client(lambda request: httpx.Response(200, json=data)).get("gpu-a")
            assert rate.hourly_usd == Decimal("0.200000")
            assert rate.source == "Akash lease plus margin"
    asyncio.run(run())


def test_per_gpu_canonical_and_wire_model_configuration(monkeypatch):
    monkeypatch.setenv("GPU_B_MODEL_ID", "Qwen/Qwen2.5-3B-Instruct")
    monkeypatch.setenv("GPU_B_WIRE_MODEL", "verified-b-wire-alias")
    settings = Settings.from_env()
    assert settings.canonical_model("gpu-b") == "Qwen/Qwen2.5-3B-Instruct"
    assert settings.wire_model("gpu-b") == "verified-b-wire-alias"

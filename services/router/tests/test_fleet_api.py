from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from router.catalog import iso
from router.collectors.base import CollectContext
from router.fleet import FleetState
from router.main import app
from router.service import Service, service

NOW = datetime.now(UTC)


@pytest.fixture
def svc():
    s = Service()
    s.collect(ctx=CollectContext(now=NOW))
    return s


def test_view_reports_queue_wait_when_full(svc):
    e = svc.entry("gpu-b3")  # maxConcurrent 1
    svc.state.start_job("gpu-b3", "j1", NOW + timedelta(seconds=40))
    v = svc.state.view(e, NOW)
    assert v.activeJobs == 1 and v.queueWaitSeconds == pytest.approx(40)
    svc.state.end_job("gpu-b3", "j1")
    assert svc.state.view(e, NOW).queueWaitSeconds == 0


def test_reclaim_makes_gpu_unavailable_until_it_returns(svc):
    svc.state.reclaim("gpu-a3", NOW, 300, "RECLAIMED")
    assert svc.state.view(svc.entry("gpu-a3"), NOW).reason == "RECLAIMED"
    assert svc.state.view(svc.entry("gpu-a3"), NOW + timedelta(seconds=301)).available


def test_stale_offer_is_not_available(svc):
    later = NOW + timedelta(hours=3)
    v = svc.state.view(svc.entry("gpu-a2"), later)
    assert v.reason == "STALE_PRICE" and not v.available
    assert svc.state.view(svc.entry("gpu-a1"), later).available  # Moonshift's listed price never goes stale


def test_missing_offer_is_not_executable(svc):
    svc.offers.pop("vast#US#1x RTX 4090#marketplace")
    svc.load_catalog([])
    e = svc.entry("gpu-b3")
    v = svc.state.view(e, NOW)
    assert v.reason == "OFFER_MISSING" and not v.executable


async def test_compute_calendar_becomes_booked_windows(svc):
    start, end = NOW + timedelta(minutes=10), NOW + timedelta(minutes=20)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/gpus":
            return httpx.Response(200, json=[{"id": "gpu-a", "state": "READY"}, {"id": "gpu-b", "state": "OFFLINE"}])
        return httpx.Response(
            200,
            json=[
                {"start": iso(start), "end": iso(end), "kind": "BOOKED", "ref": "r1"},
                {"start": iso(start), "end": iso(end), "kind": "INFERENCE", "ref": "x"},
            ],
        )

    state = FleetState()
    await state.refresh_compute(svc.entries, transport=httpx.MockTransport(handler))
    v = state.view(svc.entry("gpu-a1"), NOW)
    assert len(v.bookedWindows) == 1
    assert v.bookedWindows[0][0] == pytest.approx(600, abs=1)
    assert state.view(svc.entry("gpu-b1"), NOW).reason == "OFFLINE"


def test_http_catalog_fleet_and_reclaim():
    with TestClient(app) as client:
        assert client.get("/health").json()["gpus"] == 6
        cat = client.get("/catalog", params={"provider": "aws", "gpuModel": "T4"}).json()
        assert cat["count"] >= 2 and {o["provider"] for o in cat["offers"]} == {"aws"}
        fleet = client.get("/fleet").json()
        assert {g["provider"] for g in fleet} == {"moonshift", "aws", "azure", "vast"}
        assert all(isinstance(g["endpoint"], bool) for g in fleet)
        r = client.post("/fleet/gpu-a3/reclaim", json={"warningSeconds": 5}).json()
        assert r["warningSeconds"] == 5 and r["label"] == "GPU-A3"
        assert client.post("/fleet/gpu-b2/reclaim", json={}).status_code == 409  # on-demand
        assert client.post("/fleet/nope/reclaim", json={}).status_code == 404
        service.state.reclaims.clear()

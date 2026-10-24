import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from compute.config import Settings
from compute.main import create_app

CONTRACTS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "contracts" / "compute"


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        mock=True,
        api_url="",
        pricing_url="",
        internal_api_key="test-internal-key",
        vllm_url="http://127.0.0.1:8000/v1",
        gpu_b_vllm_url="http://127.0.0.1:8001/v1",
        model="Qwen/Qwen3-1.7B",
        gpu_b_mode="simulated",
        slot_minutes=5,
        guard_seconds=10.0,
        drain_lead_seconds=30.0,
        prefill_seconds=0.1,
        network_seconds=0.05,
        request_timeout_seconds=5.0,
        public_input_token_limit=2000,
        public_max_tokens=256,
        mock_latency_seconds=0.01,
        gpu_a_tokens_per_sec=45.0,
        gpu_b_tokens_per_sec=35.0,
        state_dir=tmp_path,
        pricing_cache_seconds=30.0,
    )
    app = create_app(settings)
    return TestClient(app)


def test_revenue_default_24_buckets(client):
    resp = client.get("/gpus/gpu-a/revenue")
    assert resp.status_code == 200
    buckets = resp.json()
    assert len(buckets) == 24
    for b in buckets:
        assert "start" in b
        assert "end" in b
        assert "revenue" in b
        assert "bookedMinutes" in b
        assert "inferenceMinutes" in b
        assert "idleMinutes" in b
        assert "utilizationPct" in b
        assert "simulated" in b
        assert isinstance(b["simulated"], bool)
        assert float(b["revenue"]) >= 0.0
        assert 0.0 <= float(b["utilizationPct"]) <= 100.0


def test_revenue_custom_range_and_bucket(client):
    now = datetime.now(UTC)
    start = now - timedelta(hours=6)
    resp = client.get(
        f"/gpus/gpu-a/revenue?from={start.isoformat()}&to={now.isoformat()}&bucket=30m"
    )
    assert resp.status_code == 200
    buckets = resp.json()
    # 6 hours with 30m buckets = 12 buckets
    assert len(buckets) == 12


def test_revenue_invalid_range_rejected(client):
    now = datetime.now(UTC)
    earlier = now - timedelta(hours=2)
    # from is after to
    resp = client.get(f"/gpus/gpu-a/revenue?from={now.isoformat()}&to={earlier.isoformat()}")
    assert resp.status_code == 400


def test_revenue_unknown_gpu_returns_404(client):
    resp = client.get("/gpus/gpu-unknown/revenue")
    assert resp.status_code == 404


def test_revenue_matches_contract_shape(client):
    with open(CONTRACTS_DIR / "revenue.json") as f:
        contract = json.load(f)

    req = contract["request"]
    resp = client.get(
        f"/gpus/{req['gpuId']}/revenue?from={req['from']}&to={req['to']}&bucket={req['bucket']}"
    )
    assert resp.status_code == 200
    buckets = resp.json()
    assert len(buckets) > 0
    expected_keys = {
        "start",
        "end",
        "revenue",
        "bookedMinutes",
        "inferenceMinutes",
        "idleMinutes",
        "utilizationPct",
        "simulated",
    }
    assert set(buckets[0].keys()) == expected_keys

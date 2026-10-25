from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient

from compute.config import Settings
from compute.main import create_app


def test_mock_chat_is_openai_compatible_and_metered(tmp_path) -> None:
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0)
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/chat/completions",
            headers={"X-MS-Buyer": "DEV"},
            json={"messages": [{"role": "user", "content": "hello GPU"}], "max_tokens": 64},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["x_ms"]["simulated"] is True
    assert Decimal(body["x_ms"]["charge"]) > 0
    assert len(body["x_ms"]["charge"].split(".")[1]) == 6


def test_booking_endpoint_requires_key_and_stream_includes_moonshift_metadata(tmp_path) -> None:
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0)
    with TestClient(create_app(settings)) as client:
        unauthenticated = client.post(
            "/bookings",
            json={
                "gpu_id": "gpu-a",
                "slot_start": (datetime.now(UTC) + timedelta(minutes=2)).isoformat(),
                "slots": 1,
                "redemption_id": "redemption-3",
                "holder": "ALICE",
            },
        )
        assert unauthenticated.status_code == 401

        stream = client.post(
            "/v1/chat/completions",
            headers={"X-MS-Buyer": "DEV"},
            json={"stream": True, "messages": [{"role": "user", "content": "stream this"}]},
        )
    assert stream.status_code == 200
    assert "moonshift.metadata" in stream.text
    assert "data: [DONE]" in stream.text


def test_active_booking_preempts_public_inference_and_bills_the_holder_zero(tmp_path) -> None:
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0)
    now = datetime.now(UTC)
    with TestClient(create_app(settings)) as client:
        booked = client.post(
            "/bookings",
            headers={"X-MS-Internal-Key": settings.internal_api_key},
            json={
                "gpu_id": "gpu-a",
                "slot_start": (now - timedelta(seconds=1)).isoformat(),
                "slots": 1,
                "redemption_id": "redemption-live",
                "holder": "ALICE",
            },
        )
        assert booked.status_code == 200

        holder_response = client.post(
            "/v1/chat/completions",
            headers={"X-MS-Buyer": "ALICE", "X-MS-Booking": "redemption-live"},
            json={"messages": [{"role": "user", "content": "my reserved request"}]},
        )
        public_response = client.post(
            "/v1/chat/completions",
            headers={"X-MS-Buyer": "DEV"},
            json={"messages": [{"role": "user", "content": "public request"}]},
        )

    assert holder_response.status_code == 200
    holder_metadata = holder_response.json()["x_ms"]
    assert holder_metadata["gpu_id"] == "gpu-a"
    assert holder_metadata["charge"] == "0.000000"
    assert holder_metadata["routed_reason"] == "ACTIVE_BOOKING"

    assert public_response.status_code == 200
    public_metadata = public_response.json()["x_ms"]
    assert public_metadata["gpu_id"] == "gpu-b"
    assert {"gpu_id": "gpu-a", "reason": "GPU_BOOKED"} in public_metadata["skipped_gpus"]


def test_dynamic_worker_registration_and_scaling(tmp_path) -> None:
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0)
    with TestClient(create_app(settings)) as client:
        # Initial workers
        initial_gpus = client.get("/gpus").json()
        assert len(initial_gpus) == 2

        # Register dynamic GPU node (e.g. Akash A100 or additional node)
        reg = client.post(
            "/internal/workers/register",
            headers={"X-MS-Internal-Key": settings.internal_api_key},
            json={
                "gpu_id": "gpu-c",
                "model": "Qwen/Qwen2.5-32B-Instruct",
                "tokens_per_sec": 55.0,
                "simulated": False,
            },
        )
        assert reg.status_code == 200
        assert reg.json()["registered"] is True
        assert reg.json()["gpu_id"] == "gpu-c"

        # List now reflects 3 nodes
        updated_gpus = client.get("/gpus").json()
        assert len(updated_gpus) == 3
        gpu_ids = [g["id"] for g in updated_gpus]
        assert "gpu-c" in gpu_ids

        # Monte carlo status includes dynamic node
        mc_status = client.get("/monte-carlo/status").json()
        assert "gpu-c" in mc_status
        assert "risk_simulation" in mc_status["gpu-c"]

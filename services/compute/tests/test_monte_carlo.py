from __future__ import annotations

import asyncio
from dataclasses import replace
import pytest

from compute.config import Settings
from compute.main import create_app
from compute.monte_carlo import MonteCarloRiskEngine
from fastapi.testclient import TestClient


@pytest.mark.asyncio
async def test_monte_carlo_engine_math_and_preemption() -> None:
    engine = MonteCarloRiskEngine(
        gpu_id="gpu-a",
        resident_model="Qwen/Qwen2.5-1.5B-Instruct",
        total_vram_gb=16.0,
        model_vram_gb=3.5,
        target_paths_per_sec=100_000.0,
    )
    assert engine.status == "IDLE"

    engine.start()
    assert engine.status == "RUNNING"

    # Allow simulation to run briefly
    await asyncio.sleep(0.15)
    metrics = engine.metrics()
    assert metrics["status"] == "RUNNING"
    assert metrics["risk_simulation"]["paths_simulated"] > 0
    assert metrics["risk_simulation"]["value_at_risk_99"] > 0

    # Instant preemption
    latency = await engine.preempt("TEST_INFERENCE")
    assert latency > 0
    assert engine.status == "PREEMPTED"
    preempted_metrics = engine.metrics()
    assert preempted_metrics["status"] == "PREEMPTED"
    assert preempted_metrics["instant_preemption"]["total_switches"] == 1

    # Resume
    await engine.resume()
    assert engine.status == "RUNNING"
    await engine.stop()


def test_instant_switch_api_endpoint(tmp_path) -> None:
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock_latency_seconds=0)
    with TestClient(create_app(settings)) as client:
        status_resp = client.get("/monte-carlo/status")
        assert status_resp.status_code == 200
        status_data = status_resp.json()
        assert "gpu-a" in status_data
        assert "gpu-b" in status_data

        demo_resp = client.post("/monte-carlo/switch-demo?gpu_id=gpu-a")
        assert demo_resp.status_code == 200
        demo_data = demo_resp.json()
        assert demo_data["demo"] == "INSTANT_GPU_WORKLOAD_SWITCH"
        assert demo_data["switch_transition"]["initial_workload"] == "MONTE_CARLO_RISK_SIMULATION"
        assert demo_data["switch_transition"]["switched_to"] == "LLM_INFERENCE"
        assert demo_data["switch_transition"]["preemption_latency_ms"] > 0
        assert demo_data["switch_transition"]["idle_waste_seconds"] == 0.0

from __future__ import annotations

import importlib.util
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location("measure_planning", Path(__file__).parents[1] / "measure_planning.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


def samples():
    return [{"observedAt": "2026-10-25T15:00:00Z", "completionTokens": 128, "wallSeconds": 2.0},
            {"observedAt": "2026-10-25T15:00:02Z", "completionTokens": 128, "wallSeconds": 4.0}]


def test_full_wall_time_minimum_not_peak_or_another_models_rate():
    record = module.performance_record("gpu-c", "Qwen/Qwen2.5-3B-Instruct", samples())
    assert record["planningTokensPerSec"] == 32
    assert record["sampleCount"] == 2
    assert record["modelId"] == "Qwen/Qwen2.5-3B-Instruct"


@pytest.mark.parametrize("bad", [[], samples()[:1], [*samples(), samples()[0]],
                                  [samples()[0], {**samples()[1], "completionTokens": 3}],
                                  [samples()[0], {**samples()[1], "wallSeconds": 0}],
                                  [samples()[0], {**samples()[1], "wallSeconds": float("nan")}]])
def test_missing_tiny_or_invalid_measurements_cannot_enable_a_node(bad):
    with pytest.raises(ValueError):
        module.performance_record("gpu-c", "Qwen/Qwen2.5-3B-Instruct", bad)


def test_wrong_endpoint_identity_fails_before_any_generation():
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={"data": [{"id": "other-model", "root": "other-model"}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError, match="model"):
            module.measure("gpu-c", {"GPU_C_VLLM_URL": "http://private-node/v1", "GPU_C_MODE": "real", "GPU_C_MODEL_ID": "Qwen/Qwen2.5-3B-Instruct",
                                     "GPU_C_CARD": "NVIDIA V100", "GPU_C_VRAM_GB": "32", "GPU_C_VCPU": "4", "GPU_C_RAM_GB": "16", "GPU_C_STORAGE_GB": "50",
                                     "GPU_C_LEASE_USD_PER_HOUR": "0.2", "GPU_C_PRICE_UPDATED_AT": "2026-10-25T15:00:00Z"}, client)
    assert calls == ["/v1/models"]


def test_env_update_changes_only_observed_public_scalars(tmp_path):
    path = tmp_path / ".env"
    path.write_text("# preserved\nPRIVATE_VALUE=private-test-fixture\nGPU_C_TOKENS_PER_SEC=0\n")
    path.chmod(0o600)
    module.update_settings(path, {"GPU_C_TOKENS_PER_SEC": "32.0", "GPU_C_PLANNING_MODEL_ID": "Qwen/Qwen2.5-3B-Instruct"})
    assert path.read_text() == "# preserved\nPRIVATE_VALUE=private-test-fixture\nGPU_C_TOKENS_PER_SEC=32.0\nGPU_C_PLANNING_MODEL_ID=Qwen/Qwen2.5-3B-Instruct\n"
    assert path.stat().st_mode & 0o777 == 0o600

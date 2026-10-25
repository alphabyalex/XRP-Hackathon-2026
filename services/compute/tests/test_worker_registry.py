"""Real worker identities, health and independent capacity using isolated HTTP transports."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime
import json

from fastapi.testclient import TestClient
import httpx
import pytest

from compute.config import Settings
from compute.main import create_app
from compute.models import ChatMessage
from compute.providers import UnavailableProvider, VllmProvider

SMALL = "Qwen/Qwen2.5-1.5B-Instruct"
MODEL = "Qwen/Qwen2.5-3B-Instruct"
IDS = tuple(f"gpu-{letter}" for letter in "abcdefgh")


def configure(monkeypatch, tmp_path, nodes=IDS):
    for gid in IDS:
        prefix = gid.upper().replace("-", "_")
        model = SMALL if gid == "gpu-a" else MODEL
        for suffix in ("VLLM_MODEL", "TOKENS_PER_SEC"):
            monkeypatch.delenv(f"{prefix}_{suffix}", raising=False)
        for key, value in {
            "MODE": "real", "VLLM_URL": f"http://{gid}", "MODEL_ID": model,
            "WIRE_MODEL": f"{gid}-wire", "PLANNING_TOKENS_PER_SEC": str(10 + IDS.index(gid)),
            "PLANNING_MODEL_ID": model, "PLANNING_SAMPLE_COUNT": "2",
            "PLANNING_OBSERVED_AT": datetime.now(UTC).isoformat(),
        }.items():
            monkeypatch.setenv(f"{prefix}_{key}", value)
    return replace(Settings.from_env(), mock=False, gpu_nodes=nodes, state_dir=tmp_path,
                   vllm_url="http://gpu-a", gpu_b_vllm_url="http://gpu-b", model=SMALL, gpu_b_mode="real")


def test_eight_distinct_verified_workers_keep_models_and_run_independently(monkeypatch, tmp_path):
    app = create_app(configure(monkeypatch, tmp_path))
    calls = []
    active = peak = 0

    async def upstream(request):
        nonlocal active, peak
        gid = request.url.host
        canonical = SMALL if gid == "gpu-a" else MODEL
        calls.append((gid, request.url.path))
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": f"{gid}-wire", "root": canonical}]})
        assert json.loads(request.content)["model"] == f"{gid}-wire"
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(200, json={"choices": [{"message": {"content": "46"}}],
                                       "usage": {"prompt_tokens": 10, "completion_tokens": 2}})

    for provider in app.state.router.providers.values():
        assert isinstance(provider, VllmProvider)
        provider.transport = httpx.MockTransport(upstream)
    with TestClient(app) as client:
        rows = client.get("/gpus").json()
        assert [row["id"] for row in rows] == list(IDS)
        assert all(row["state"] == "READY" and not row["simulated"] for row in rows)
        assert [row["tokens_per_sec"] for row in rows] == list(range(10, 18))
        assert [row["model"] for row in rows] == [SMALL] + [MODEL] * 7

        async def run():
            return await asyncio.gather(*(provider.complete(messages=[ChatMessage(role="user", content="17+29")],
                model=app.state.scheduler.worker(gid).model, max_tokens=16, temperature=None)
                for gid, provider in app.state.router.providers.items()))

        assert all(reply.content == "46" for reply in asyncio.run(run()))
        assert peak == 8  # Each real endpoint has independent capacity, never eight aliases of one node.
    assert len(calls) == 16


def test_health_model_mismatch_duplicate_endpoint_and_reclaim_fail_closed(monkeypatch, tmp_path):
    settings = configure(monkeypatch, tmp_path, ("gpu-c", "gpu-d", "gpu-e"))
    monkeypatch.setenv("GPU_C_VLLM_URL", "http://localhost:8123/v1/")
    monkeypatch.setenv("GPU_D_VLLM_URL", "http://127.0.0.1:8123")
    app = create_app(settings)
    healthy = {"gpu-c": True, "gpu-e": False}
    for gid in healthy:
        provider = app.state.router.providers[gid]
        provider.transport = httpx.MockTransport(lambda request, gid=gid: httpx.Response(200,
            json={"data": [{"id": f"{gid}-wire", "root": MODEL if healthy[gid] else SMALL}]}))
    assert isinstance(app.state.router.providers["gpu-d"], UnavailableProvider)
    with TestClient(app) as client:
        def states():
            return {row["id"]: row["state"] for row in client.get("/gpus").json()}
        assert states() == {"gpu-c": "READY", "gpu-d": "OFFLINE", "gpu-e": "OFFLINE"}
        healthy["gpu-e"] = True
        asyncio.run(app.state.refresh_worker_health())
        assert states()["gpu-e"] == "READY"
        app.state.scheduler.worker("gpu-c").set_offline(True)
        asyncio.run(app.state.refresh_worker_health())
        assert states()["gpu-c"] == "OFFLINE"  # A health refresh cannot undo a reclaim.
        app.state.scheduler.worker("gpu-c").set_offline(False)
        healthy["gpu-c"] = False
        asyncio.run(app.state.refresh_worker_health())
        assert states()["gpu-c"] == "OFFLINE"


@pytest.mark.parametrize("field,value", [("MODEL_ID", ""), ("MODE", "simulated"),
    ("PLANNING_TOKENS_PER_SEC", "nan"), ("PLANNING_MODEL_ID", SMALL),
    ("PLANNING_SAMPLE_COUNT", "1"), ("PLANNING_OBSERVED_AT", "invalid")])
def test_unverified_new_node_never_inherits_a_or_b_metadata(monkeypatch, tmp_path, field, value):
    settings = configure(monkeypatch, tmp_path, ("gpu-c",))
    monkeypatch.setenv(f"GPU_C_{field}", value)
    app = create_app(settings)
    assert isinstance(app.state.router.providers["gpu-c"], UnavailableProvider)
    with TestClient(app) as client:
        row = client.get("/gpus").json()[0]
        assert row["state"] == "OFFLINE" and row["simulated"] is False


@pytest.mark.parametrize("value", ["gpu-a,gpu-a", "gpu-a,gpu-i", "gpu-A"])
def test_node_list_rejects_aliases_and_unsupported_ids(monkeypatch, value):
    monkeypatch.setenv("GPU_NODES", value)
    with pytest.raises(ValueError, match="GPU_NODES"):
        Settings.from_env()

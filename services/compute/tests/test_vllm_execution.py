"""Real-provider protocol tests, without reaching a GPU or returning canned live answers."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from compute.config import Settings
from compute.main import create_app
from compute.models import ChatMessage
from compute.pricing import RateClient
from compute.providers import ProviderError, VllmProvider
from compute.resume import StreamRequest, vllm_tokens

MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
ALIAS = "Qwen/Qwen3-1.7B"


def stream_response(*choices: dict, done: bool = True) -> httpx.Response:
    text = "".join(f"data: {json.dumps({'choices': [choice]})}\n\n" for choice in choices)
    if done:
        text += "data: [DONE]\n\n"
    return httpx.Response(200, text=text, headers={"Content-Type": "text/event-stream"})


def test_fresh_task_uses_plain_chat_completion_for_vllm_062():
    requests = []

    def upstream(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        assert request.url.path == "/v1/chat/completions"
        assert body == {"model": ALIAS, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 20, "stream": True}
        return stream_response({"delta": {"content": "Hello"}, "finish_reason": None}, {"delta": {}, "finish_reason": "stop"})

    async def run():
        provider = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(upstream))
        req = StreamRequest(gpuId="gpu-a", messages=[ChatMessage(role="user", content="Hi")], maxTokens=20)
        assert [part async for part in vllm_tokens(provider, req, MODEL)] == ["Hello"]

    asyncio.run(run())
    assert len(requests) == 1


def test_resume_applies_qwen_chat_template_and_continues_open_reply():
    partial = "A GPU runs"

    def upstream(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.url.path == "/v1/completions"
        assert body["model"] == ALIAS
        assert body["max_tokens"] == 17
        assert body["prompt"] == (
            "<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n"
            "<|im_start|>user\nExplain a GPU.<|im_end|>\n<|im_start|>assistant\nA GPU runs"
        )
        assert "messages" not in body and "continue_final_message" not in body
        assert body["stop"] == ["<|im_end|>", "<|endoftext|>"]
        return stream_response({"text": " parallel operations.", "finish_reason": "stop"})

    async def run():
        provider = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(upstream))
        req = StreamRequest(gpuId="gpu-a", messages=[ChatMessage(role="user", content="Explain a GPU.")],
                            maxTokens=20, resume={"text": partial, "tokens": 3})
        reply = partial + "".join([part async for part in vllm_tokens(provider, req, MODEL)])
        assert reply == "A GPU runs parallel operations."

    asyncio.run(run())


def test_truncated_upstream_is_an_error_not_a_completed_task():
    async def run():
        provider = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(
            lambda request: stream_response({"delta": {"content": "partial"}}, done=False)
        ))
        req = StreamRequest(gpuId="gpu-a", messages=[ChatMessage(role="user", content="Hi")])
        with pytest.raises(ProviderError, match="complete answer"):
            _ = [part async for part in vllm_tokens(provider, req, MODEL)]

    asyncio.run(run())


def test_failed_provider_returns_503_and_never_bills_or_fakes_a_reply(tmp_path):
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock=True, model=MODEL, mock_latency_seconds=0)
    app = create_app(settings)

    class Usage:
        events = []

        async def report(self, event):
            self.events.append(event)

    usage = Usage()
    app.state.router.usage_reporter = usage
    provider = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(lambda request: httpx.Response(400)))
    app.state.router.providers.update({gid: provider for gid in app.state.router.providers})
    with TestClient(app) as client:
        response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "DEV"},
                               json={"messages": [{"role": "user", "content": "Hi"}]})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "UPSTREAM_ERROR"
        stream = client.post("/v1/resume/stream", headers={"X-MS-Internal-Key": settings.internal_api_key},
                             json={"gpuId": "gpu-a", "messages": [{"role": "user", "content": "Hi"}], "reportUsage": True})
        assert stream.status_code == 503
        assert stream.json()["error"]["code"] == "UPSTREAM_ERROR"
    assert usage.events == []


def test_live_workers_without_endpoints_are_offline(tmp_path):
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock=False, vllm_url="", gpu_b_vllm_url="")
    with TestClient(create_app(settings)) as client:
        assert all(gpu["state"] == "OFFLINE" for gpu in client.get("/gpus").json())
        response = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "DEV"},
                               json={"messages": [{"role": "user", "content": "Hi"}]})
        assert response.status_code == 503


def test_public_model_is_real_model_while_upstream_uses_legacy_alias():
    def upstream(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["model"] == ALIAS
        return httpx.Response(200, json={"model": ALIAS, "choices": [{"message": {"content": "Hello"}}],
                                        "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

    async def run():
        provider = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(upstream))
        completion = await provider.complete(messages=[ChatMessage(role="user", content="Hi")], model=MODEL,
                                             max_tokens=20, temperature=None)
        assert completion.model == MODEL

    asyncio.run(run())


def test_gpu_a_url_and_real_model_configuration(monkeypatch):
    monkeypatch.setenv("GPU_A_VLLM_URL", "http://gpu-a/")
    monkeypatch.setenv("VLLM_URL", "http://old")
    monkeypatch.setenv("MODEL", ALIAS)
    monkeypatch.delenv("GPU_A_VLLM_MODEL", raising=False)
    settings = Settings.from_env()
    assert settings.vllm_url == "http://gpu-a"
    assert settings.model == MODEL
    assert settings.upstream_model == ALIAS


def test_live_workers_cannot_register_the_same_endpoint_twice(tmp_path):
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock=False,
                       vllm_url="http://same-worker", gpu_b_vllm_url="http://same-worker/v1/")
    app = create_app(settings)
    with TestClient(app) as client:
        workers = {gpu["id"]: gpu for gpu in client.get("/gpus").json()}
        assert workers["gpu-a"]["state"] == "READY"
        assert workers["gpu-b"]["state"] == "OFFLINE"


def test_live_compute_omits_cpu_fixture_and_inference_still_works(tmp_path):
    settings = replace(Settings.from_env(), state_dir=tmp_path, mock=False, model=MODEL,
                       vllm_url="http://worker", gpu_b_vllm_url="", api_url="", pricing_url="")
    app = create_app(settings)
    calls = []

    def upstream(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={"model": ALIAS, "choices": [{"message": {"content": "Real provider path"}}],
                                        "usage": {"prompt_tokens": 2, "completion_tokens": 3}})

    app.state.router.providers["gpu-a"] = VllmProvider("http://worker", 5, ALIAS, httpx.MockTransport(upstream))
    app.state.router.rates = RateClient("", 30, 5, False, api_url="http://api", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"gpus": [{"id": "gpu-a", "status": "serving", "prices": {
            "rentalUsdPerHour": "0.550000", "economy": {"usdPerHour": "0.550000", "updatedAt": datetime.now(UTC).isoformat()}
        }}]})
    ))
    with TestClient(app) as client:
        assert all(worker.monte_carlo is None for worker in app.state.scheduler.workers.values())
        assert all("monte_carlo" not in gpu for gpu in client.get("/gpus").json())
        assert client.get("/monte-carlo/status").json() == {}
        disabled = client.post("/monte-carlo/switch-demo?gpu_id=gpu-a")
        assert disabled.status_code == 503
        assert disabled.json()["error"]["code"] == "FEATURE_UNAVAILABLE"
        assert calls == []
        reply = client.post("/v1/chat/completions", headers={"X-MS-Buyer": "DEV"},
                            json={"messages": [{"role": "user", "content": "Hi"}], "max_tokens": 10})
        assert reply.status_code == 200, reply.text
        assert reply.json()["choices"][0]["message"]["content"] == "Real provider path"
        assert reply.json()["x_ms"]["simulated"] is False
        assert calls == ["/v1/chat/completions"]
        assert all(worker.monte_carlo is None for worker in app.state.scheduler.workers.values())

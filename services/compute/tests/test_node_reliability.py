"""Concurrency, retry boundaries and deterministic cleanup for live model execution."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import httpx
import pytest

from compute.config import Settings
from compute.main import create_app
from compute.models import ChatMessage
from compute.providers import ProviderError, VllmProvider
from compute.resume import StreamRequest, vllm_tokens

MODEL = "Qwen/Qwen2.5-1.5B-Instruct"
MESSAGES = [ChatMessage(role="user", content="Hi")]


def completion():
    return httpx.Response(200, json={"choices": [{"message": {"content": "Hello"}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


def event(content="Hello"):
    return f"data: {json.dumps({'choices': [{'delta': {'content': content}, 'finish_reason': None}]})}\n\n".encode()


class OpenStream(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False

    async def __aiter__(self):
        yield event()
        await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


def test_chat_and_stream_share_one_node_lock_and_close_releases_it():
    async def run():
        calls = []
        body = OpenStream()

        def upstream(request):
            streaming = json.loads(request.content)["stream"]
            calls.append(streaming)
            return httpx.Response(200, stream=body) if streaming else completion()

        provider = VllmProvider("http://localhost:5000/v1/", 5, "wire-alias", httpx.MockTransport(upstream))
        other = VllmProvider("http://127.0.0.1:5000", 5, "wire-alias", provider.transport)
        stream = vllm_tokens(provider, StreamRequest(gpuId="gpu-a", messages=MESSAGES), MODEL)
        assert await anext(stream) == "Hello"
        pending = asyncio.create_task(other.complete(messages=MESSAGES, model=MODEL, max_tokens=10, temperature=None))
        await asyncio.sleep(0)
        assert calls == [True] and not pending.done()
        await stream.aclose()
        assert body.closed
        assert (await asyncio.wait_for(pending, 1)).content == "Hello"
        assert calls == [True, False]

    # Repeated event loops must never reuse an asyncio lock bound to the previous loop.
    asyncio.run(run())
    asyncio.run(run())


@pytest.mark.parametrize("status, attempts", [(503, 2), (429, 2), (400, 1), (404, 1)])
def test_nonstream_retries_only_transient_failures(monkeypatch, status, attempts):
    monkeypatch.setattr("compute.providers.RETRY_DELAY_SECONDS", 0)
    calls = []

    def upstream(request):
        calls.append(request)
        return httpx.Response(status) if len(calls) == 1 else completion()

    async def run():
        provider = VllmProvider("http://worker", 5, transport=httpx.MockTransport(upstream))
        if attempts == 2:
            assert (await provider.complete(messages=MESSAGES, model=MODEL, max_tokens=10, temperature=None)).content == "Hello"
        else:
            with pytest.raises(ProviderError):
                await provider.complete(messages=MESSAGES, model=MODEL, max_tokens=10, temperature=None)

    asyncio.run(run())
    assert len(calls) == attempts


@pytest.mark.parametrize("partial", [False, True])
def test_stream_retry_never_replays_visible_output(monkeypatch, partial):
    monkeypatch.setattr("compute.resume.RETRY_DELAY_SECONDS", 0)
    calls = []

    def upstream(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, content=event()) if partial else httpx.Response(503)
        return httpx.Response(200, content=event() + b"data: [DONE]\n\n")

    async def run():
        provider = VllmProvider("http://worker", 5, transport=httpx.MockTransport(upstream))
        req = StreamRequest(gpuId="gpu-b", messages=MESSAGES)
        if partial:
            with pytest.raises(ProviderError):
                _ = [piece async for piece in vllm_tokens(provider, req, MODEL)]
        else:
            assert [piece async for piece in vllm_tokens(provider, req, MODEL)] == ["Hello"]

    asyncio.run(run())
    assert len(calls) == (1 if partial else 2)


def test_closing_http_response_after_first_token_releases_gpu_and_upstream(tmp_path):
    async def run():
        settings = replace(Settings.from_env(), mock=True, state_dir=tmp_path, api_url="", pricing_url="")
        app = create_app(settings)
        body = OpenStream()
        app.state.router.providers["gpu-a"] = VllmProvider("http://worker", 5, transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=body)))
        route = next(route for route in app.routes if route.path == "/v1/resume/stream")
        response = await route.endpoint(StreamRequest(gpuId="gpu-a", messages=MESSAGES), settings.internal_api_key)
        assert '"kind": "token"' in await anext(response.body_iterator)
        assert (await app.state.scheduler.worker("gpu-a").status())["state"] == "SERVING"
        await response.body_iterator.aclose()
        assert body.closed
        assert (await app.state.scheduler.worker("gpu-a").status())["state"] == "READY"

    asyncio.run(run())


def test_gpu_b_uses_its_own_wire_model_and_verified_qwen3b_template():
    async def run():
        bodies = []

        def upstream(request):
            body = json.loads(request.content)
            bodies.append(body)
            assert body["model"] == "gpu-b-wire-alias"
            if not body["stream"]:
                return completion()
            assert request.url.path == "/v1/completions"
            assert body["prompt"].endswith("<|im_start|>assistant\nThe answer is")
            assert "Cloud.\nYou are a helpful assistant." in body["prompt"]
            return httpx.Response(200, content=b'data: {"choices":[{"text":" two.","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

        model = "Qwen/Qwen2.5-3B-Instruct"
        provider = VllmProvider("http://gpu-b", 5, "gpu-b-wire-alias", httpx.MockTransport(upstream))
        reply = await provider.complete(messages=MESSAGES, model=model, max_tokens=16, temperature=None)
        assert reply.model == model
        request = StreamRequest(gpuId="gpu-b", messages=MESSAGES, maxTokens=16,
                                resume={"text": "The answer is", "tokens": 3})
        assert [piece async for piece in vllm_tokens(provider, request, model)] == [" two."]
        assert len(bodies) == 2

    asyncio.run(run())

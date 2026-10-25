"""Modern Qwen uses its actual serving template; legacy nodes receive no new options."""
import asyncio
import json

import httpx
import pytest
from compute.models import ChatMessage
from compute.providers import VllmProvider, ProviderError
from compute.resume import StreamRequest, ResumeState, vllm_tokens

MODEL = "Qwen/Qwen3.5-4B"

def test_modern_fresh_and_resume_use_non_thinking_and_exact_server_template():
    async def run():
        calls = []
        def handle(request):
            body = json.loads(request.content)
            calls.append((request.url.path, body))
            if request.url.path == "/tokenize":
                assert body["messages"][-1] == {"role":"assistant", "content":"The answer is "}
                assert body["continue_final_message"] is True
                assert body["add_generation_prompt"] is False
                return httpx.Response(200, json={"tokens":[151644,42,151645]})
            assert body["model"] == MODEL
            if request.url.path == "/v1/completions":
                assert body["prompt"] == [151644,42,151645]
                assert "continue_final_message" not in body
                event = {"choices":[{"text":"46", "finish_reason":"stop"}]}
            else:
                assert body["chat_template_kwargs"] == {"enable_thinking":False}
                event = {"choices":[{"delta":{"content":"46"}, "finish_reason":"stop"}]}
            return httpx.Response(200, text=f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n")
        provider=VllmProvider("http://node",2,MODEL,httpx.MockTransport(handle))
        for resume in [ResumeState(),ResumeState(text="The answer is ",tokens=4)]:
            req=StreamRequest(gpuId="gpu-e", messages=[ChatMessage(role="user",content="What is 23+23?")],maxTokens=12,resume=resume)
            assert "".join([piece async for piece in vllm_tokens(provider,req,MODEL)]) == "46"
        assert [path for path,_ in calls] == ["/v1/chat/completions","/tokenize","/v1/completions"]
    asyncio.run(run())

def test_failed_modern_template_never_falls_back_to_a_different_models_template():
    async def run():
        def handle(request):
            assert request.url.path == "/tokenize"
            return httpx.Response(400,json={"error":"unsupported"})
        provider=VllmProvider("http://node",2,MODEL,httpx.MockTransport(handle))
        req=StreamRequest(gpuId="gpu-e",messages=[ChatMessage(role="user",content="Continue")],maxTokens=12,resume=ResumeState(text="A partial",tokens=4))
        with pytest.raises(ProviderError):
            _=[piece async for piece in vllm_tokens(provider,req,MODEL)]
    asyncio.run(run())

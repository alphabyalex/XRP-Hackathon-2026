"""Model-provider adapters for mock mode and vLLM's OpenAI-compatible API."""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Protocol

import httpx

from .models import ChatMessage


class ProviderError(RuntimeError):
    """The upstream model server could not complete a request."""


@dataclass(frozen=True, slots=True)
class Completion:
    content: str
    input_tokens: int
    output_tokens: int
    model: str


class ModelProvider(Protocol):
    async def complete(
        self,
        *,
        messages: list[ChatMessage],
        model: str,
        max_tokens: int,
        temperature: float | None,
    ) -> Completion: ...


def estimate_text_tokens(text: str) -> int:
    """A deliberately conservative local estimate used before vLLM responds."""

    return max(1, math.ceil(len(text) / 4))


class MockProvider:
    """Canned, visibly simulated answers for local integration and demos."""

    def __init__(self, latency_seconds: float) -> None:
        self.latency_seconds = latency_seconds

    async def complete(
        self,
        *,
        messages: list[ChatMessage],
        model: str,
        max_tokens: int,
        temperature: float | None,
    ) -> Completion:
        await asyncio.sleep(self.latency_seconds)
        last_user = next((message.content for message in reversed(messages) if message.role == "user"), "")
        clipped = last_user.strip().replace("\n", " ")[:180]
        content = (
            "SIMULATED GPU response. "
            f"I received: {clipped or 'your request'}. "
            "Connect a real vLLM worker by setting MOCK=0."
        )
        return Completion(
            content=content,
            input_tokens=sum(estimate_text_tokens(message.content) for message in messages),
            output_tokens=min(estimate_text_tokens(content), max_tokens),
            model=model,
        )


class VllmProvider:
    """A minimal adapter for a vLLM process bound to loopback only."""

    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def complete(
        self,
        *,
        messages: list[ChatMessage],
        model: str,
        max_tokens: int,
        temperature: float | None,
    ) -> Completion:
        payload: dict[str, object] = {
            "model": model,
            "messages": [message.model_dump() for message in messages],
            "max_tokens": max_tokens,
            "stream": False,
            # Qwen3's thinking mode makes demo latency and pricing unpredictable.
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if temperature is not None:
            payload["temperature"] = temperature

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(f"{self.base_url}/v1/chat/completions", json=payload)
                response.raise_for_status()
                body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise ProviderError("vLLM did not return a valid completion") from error

        try:
            content = str(body["choices"][0]["message"]["content"] or "")
            usage = body["usage"]
            return Completion(
                content=content,
                input_tokens=int(usage["prompt_tokens"]),
                output_tokens=int(usage["completion_tokens"]),
                model=str(body.get("model") or model),
            )
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ProviderError("vLLM response omitted completion usage") from error

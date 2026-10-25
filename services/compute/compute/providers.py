"""Model-provider adapters for mock mode and vLLM's OpenAI-compatible API."""

from __future__ import annotations

import asyncio
import math
import re
import weakref
from dataclasses import dataclass
from typing import Protocol

import httpx

from .models import ChatMessage


class ProviderError(RuntimeError):
    """The upstream model server could not complete a request."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


NODE_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 0.5
_node_locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def normalize_endpoint(base_url: str) -> str:
    """Use IPv4 for local workers and one identity for both OpenAI base URL forms."""
    return re.sub(r"^(https?://)localhost(?=[:/]|$)", r"\g<1>127.0.0.1", base_url.rstrip("/").removesuffix("/v1"))


def node_lock(base_url: str) -> asyncio.Lock:
    # Locks are shared across chat and streaming providers, but never across event loops.
    loop = asyncio.get_running_loop()
    locks = _node_locks.setdefault(loop, weakref.WeakValueDictionary())
    key = normalize_endpoint(base_url)
    lock = locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        locks[key] = lock
    return lock


def transient_upstream(error: BaseException) -> bool:
    cause = error.__cause__ or error
    return bool(getattr(error, "retryable", False)) or isinstance(
        cause, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
    ) or (isinstance(cause, httpx.HTTPStatusError) and cause.response.status_code in {408, 429, 500, 502, 503, 504})


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


class UnavailableProvider:
    """A configured worker with no endpoint cannot generate or bill an answer."""

    async def complete(self, **kwargs: object) -> Completion:
        raise ProviderError("No model endpoint is configured for this worker")


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
            f"GPU response: {clipped or 'processed request'}. "
            "Executed via Moonshift parallel compute engine."
        )
        return Completion(
            content=content,
            input_tokens=sum(estimate_text_tokens(message.content) for message in messages),
            output_tokens=min(estimate_text_tokens(content), max_tokens),
            model=model,
        )


class VllmProvider:
    """A minimal adapter for a vLLM process bound to loopback only."""

    def __init__(
        self, base_url: str, timeout_seconds: float, served_model: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = normalize_endpoint(base_url)
        self.timeout_seconds = timeout_seconds
        # The running server can use a legacy alias. Never expose that alias as the actual model.
        self.served_model = served_model
        self.transport = transport

    async def complete(
        self,
        *,
        messages: list[ChatMessage],
        model: str,
        max_tokens: int,
        temperature: float | None,
    ) -> Completion:
        async with node_lock(self.base_url):
            for attempt in range(NODE_ATTEMPTS):
                try:
                    return await self._complete_once(messages=messages, model=model, max_tokens=max_tokens,
                                                     temperature=temperature)
                except ProviderError as error:
                    if not transient_upstream(error) or attempt + 1 == NODE_ATTEMPTS:
                        raise
                    await asyncio.sleep(RETRY_DELAY_SECONDS)
        raise AssertionError("No completion attempt was made")

    async def _complete_once(
        self, *, messages: list[ChatMessage], model: str, max_tokens: int, temperature: float | None,
    ) -> Completion:
        payload: dict[str, object] = {
            "model": self.served_model or model,
            "messages": [message.model_dump() for message in messages],
            "max_tokens": max_tokens,
            "stream": False,
        }
        if temperature is not None:
            payload["temperature"] = temperature

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds, transport=self.transport) as client:
                response = await client.post(f"{self.base_url}/v1/chat/completions", json=payload)
                response.raise_for_status()
                body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise ProviderError("vLLM did not return a valid completion") from error

        try:
            content = body["choices"][0]["message"]["content"]
            usage = body["usage"]
            if not isinstance(content, str) or not content.strip():
                raise ProviderError("vLLM returned an empty or invalid answer")
            if int(usage["prompt_tokens"]) < 0 or int(usage["completion_tokens"]) <= 0:
                raise ProviderError("vLLM returned invalid completion usage")
            return Completion(
                content=content,
                input_tokens=int(usage["prompt_tokens"]),
                output_tokens=int(usage["completion_tokens"]),
                model=model,
            )
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ProviderError("vLLM response omitted completion usage") from error

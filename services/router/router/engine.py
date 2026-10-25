"""Generation engines: where a request's tokens actually come from.

ComputeEngine: a fleet entry with an endpoint is a services/compute worker running resume.py. The router
streams POST {endpoint}/v1/resume/stream (SSE) and, to reclaim, POST {endpoint}/v1/resume/interrupt.
LocalEngine: a fleet entry without an endpoint runs in-process at that GPU's tokensPerSec.

Both speak the same events: token, checkpoint, interrupted, done. A resume sends the original
messages plus the partial answer, so the next GPU continues the same reply.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from router import config as C
from router.errors import RouterError
from router.fleet import FleetEntry


@dataclass
class Signal:
    """Set by reclaim(): stop (move) or only checkpoint (rebalance)."""

    event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str = ""
    move: bool = True

    def fire(self, reason: str, move: bool = True) -> None:
        self.reason, self.move = reason, move
        self.event.set()

    def clear(self) -> None:
        self.event.clear()
        self.reason, self.move = "", True


@dataclass
class GenEvent:
    kind: str  # token | checkpoint | interrupted | done
    text: str = ""
    tokens: int = 0  # tokens generated so far in this reply (all GPUs)
    reason: str = ""


ANSWERS = [
    (
        "vwap",
        "VWAP, the volume weighted average price, is the average price a security traded at over a period, "
        "weighted by the volume at each price, and traders use it as a benchmark for whether a fill was good.",
    ),
    (
        "gpu",
        "A GPU runs thousands of small arithmetic operations in parallel, which is why it serves language models "
        "far faster than a CPU: each token is mostly large matrix multiplications that split cleanly across "
        "its cores.",
    ),
    (
        "xrpl",
        "The XRP Ledger settles payments in three to five seconds with low fees, and it has native tokens, a "
        "decentralized exchange, escrow and lending primitives built into the protocol rather than into smart "
        "contracts.",
    ),
]
GENERAL = (
    "Here is a short answer. {topic} comes down to three points: what it is, why it matters for the task "
    "in front of you, and how to check the result. Start with the definition, apply it to one concrete case, "
    "and compare the outcome with a simple baseline before relying on it."
)


# A prompt that asks for a length ("about 2500 words") gets a reply that long: the in-process
# worker keeps writing, section by section, the way a model follows a length instruction.
LENGTH = re.compile(r"about ([\d,]+) words", re.I)
SECTIONS = (
    "Section {n}. The first measure is utilization: the share of the hour the GPU spent serving paid work, "
    "read from the router's own leases rather than estimated.",
    "Section {n}. Revenue follows utilization: each served token is billed at the GPU's hourly price divided "
    "by its throughput, so an idle hour earns nothing and a busy hour earns the full rate.",
    "Section {n}. Queue time matters as much as speed: a task that waits for a free slot finishes later even "
    "on a fast card, which is why the router weighs wait, price and interruption risk together.",
    "Section {n}. Checkpoints make a move cheap: the partial reply travels with the task, so a reclaimed GPU "
    "costs a few seconds of warning window instead of a restart.",
    "Section {n}. The payout closes the loop: the day's revenue, less hosting and reserve, is split across "
    "the shares outstanding and paid to every holder in one ledger transaction.",
)


def answer_for(messages: list[dict[str, str]]) -> list[str]:
    """In-process reply text, split into word tokens (each keeps its leading space)."""
    prompt = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
    words = _base_answer(prompt)
    asked = LENGTH.search(prompt)
    if asked:
        target = min(int(asked.group(1).replace(",", "")), 20_000)
        n = 0
        while len(words) < target:
            n += 1
            words += [" " + w for w in SECTIONS[(n - 1) % len(SECTIONS)].format(n=n).split(" ")]
        words = words[:target]
    return words


def _base_answer(prompt: str) -> list[str]:
    low = prompt.lower()
    text = next((a for k, a in ANSWERS if k in low), None)
    if text is None:
        words = prompt.strip().rstrip("?.!").split()
        topic = " ".join(words[:8]) or "This"
        text = GENERAL.format(topic=topic[0].upper() + topic[1:])
        # Repeat with a stable variation so long max_tokens still has text to stream.
        seed = int(hashlib.sha256(prompt.encode()).hexdigest(), 16) % 3
        text += " " + ["Keep the inputs small at first.", "Write the steps down.", "Measure twice."][seed]
    out = []
    for i, w in enumerate(text.split(" ")):
        out.append(w if i == 0 else " " + w)
    return out


class LocalEngine:
    """Generates at the GPU's speed in-process. Used for fleet entries without an endpoint."""

    def __init__(self, time_scale: float = 1.0) -> None:
        self.time_scale = time_scale

    async def stream(
        self,
        entry: FleetEntry,
        messages: list[dict[str, str]],
        max_tokens: int,
        done_text: str,
        done_tokens: int,
        signal: Signal,
    ) -> AsyncIterator[GenEvent]:
        words = answer_for(messages)[:max_tokens]
        delay = 1.0 / max(entry.offer.tokensPerSec, 1.0) / self.time_scale
        n = done_tokens
        text = done_text
        while n < len(words):
            if signal.event.is_set():
                yield GenEvent("checkpoint", text, n, signal.reason)
                if signal.move:
                    yield GenEvent("interrupted", text, n, signal.reason)
                    return
                signal.clear()  # rebalance: checkpointed early, keep going
            await asyncio.sleep(delay)
            text += words[n]
            n += 1
            yield GenEvent("token", words[n - 1], n)
            if n % C.CHECKPOINT_EVERY_TOKENS == 0:
                yield GenEvent("checkpoint", text, n)
        yield GenEvent("done", text, n)


class ComputeEngine:
    """Streams from a services/compute worker (resume.py)."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def stream(
        self,
        entry: FleetEntry,
        messages: list[dict[str, str]],
        max_tokens: int,
        done_text: str,
        done_tokens: int,
        signal: Signal,
    ) -> AsyncIterator[GenEvent]:
        headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
        body = {
            "gpuId": entry.computeGpuId or entry.moonshiftGpuId,
            "messages": messages,
            "maxTokens": max_tokens,
            "resume": {"text": done_text, "tokens": done_tokens},
            "checkpointEvery": C.CHECKPOINT_EVERY_TOKENS,
        }
        async with httpx.AsyncClient(transport=self.transport, timeout=None, headers=headers) as http:
            watcher = asyncio.create_task(self._forward_signal(http, entry, signal))
            try:
                async with http.stream("POST", f"{entry.endpoint}/v1/resume/stream", json=body) as r:
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        ev: dict[str, Any] = json.loads(line[6:])
                        if ev.get("kind") == "error":
                            raise RouterError(503, "UPSTREAM_ERROR", "The GPU could not complete this request")
                        if ev.get("kind") not in ("token", "checkpoint", "interrupted", "done"):
                            raise RouterError(503, "UPSTREAM_ERROR", "The GPU returned an invalid stream event")
                        yield GenEvent(ev["kind"], ev.get("text", ""), int(ev.get("tokens", 0)), ev.get("reason", ""))
                        if ev["kind"] in ("interrupted", "done"):
                            return
                    raise RouterError(503, "UPSTREAM_ERROR", "The GPU stream ended before the request completed")
            finally:
                watcher.cancel()

    async def _forward_signal(self, http: httpx.AsyncClient, entry: FleetEntry, signal: Signal) -> None:
        await signal.event.wait()
        await http.post(
            f"{entry.endpoint}/v1/resume/interrupt",
            json={"gpuId": entry.computeGpuId or entry.moonshiftGpuId, "reason": signal.reason, "move": signal.move},
        )


def engine_for(entry: FleetEntry) -> LocalEngine | ComputeEngine:
    if entry.endpoint:
        return ComputeEngine()
    if C.FLEET_SOURCE == "mock":
        return LocalEngine(C.ENGINE_TIME_SCALE)
    raise RouterError(503, "GPU_OFFLINE", "No endpoint is configured for this GPU")

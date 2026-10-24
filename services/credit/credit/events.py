"""In-process event bus behind GET /events (server-sent events)."""

from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from credit import config as C


class EventBus:
    def __init__(self, history: int = 50) -> None:
        self._subscribers: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()
        self.recent: deque[tuple[str, dict[str, Any]]] = deque(maxlen=history)

    def publish(self, event_type: str, data: dict[str, Any]) -> None:
        self.recent.append((event_type, data))
        for q in list(self._subscribers):
            try:
                q.put_nowait((event_type, data))
            except asyncio.QueueFull:
                pass  # slow client; it misses this event rather than blocking everyone

    async def stream(self, ping_seconds: float = C.SSE_PING_SECONDS) -> AsyncIterator[str]:
        q: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event_type, data = await asyncio.wait_for(q.get(), timeout=ping_seconds)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield format_sse(event_type, data)
        finally:
            self._subscribers.discard(q)


def format_sse(event_type: str, data: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


bus = EventBus()

"""Bounded, persisted event log with an SSE subscription interface."""

from __future__ import annotations

import asyncio
import json
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import AsyncIterator
from uuid import uuid4


class EventLog:
    def __init__(self, state_dir: Path, capacity: int = 500) -> None:
        self.path = state_dir / "events.jsonl"
        self.capacity = capacity
        self._events: deque[dict[str, object]] = deque(maxlen=capacity)
        self._subscribers: set[asyncio.Queue[dict[str, object]]] = set()
        self._persisted_count = 0
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()[-self.capacity :]
            for line in lines:
                event = json.loads(line)
                if isinstance(event, dict):
                    self._events.append(event)
            self._persisted_count = len(self._events)
        except (OSError, json.JSONDecodeError):
            self._events.clear()

    def publish(self, event_type: str, **fields: object) -> dict[str, object]:
        event: dict[str, object] = {
            "id": str(uuid4()),
            "type": event_type,
            "occurredAt": datetime.now(UTC).isoformat(),
            **fields,
        }
        self._events.append(event)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self._persisted_count < self.capacity:
                with self.path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
                self._persisted_count += 1
            else:
                with self.path.open("w", encoding="utf-8") as stream:
                    for item in self._events:
                        stream.write(json.dumps(item, separators=(",", ":"), default=str) + "\n")
        except OSError:
            pass
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)
        return event

    def history(self) -> list[dict[str, object]]:
        return list(self._events)

    async def stream(self) -> AsyncIterator[str]:
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        try:
            for event in self._events:
                yield self._format(event)
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield self._format(event)
                except TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            self._subscribers.discard(queue)

    @staticmethod
    def _format(event: dict[str, object]) -> str:
        payload = json.dumps(event, separators=(",", ":"), default=str)
        return f"id: {event['id']}\nevent: risk\ndata: {payload}\n\n"

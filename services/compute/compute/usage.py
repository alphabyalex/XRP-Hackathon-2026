"""Idempotent delivery of completed usage events to the orchestration API."""

from __future__ import annotations

import asyncio
from dataclasses import asdict

import httpx

from .models import UsageEvent


class UsageReporter:
    def __init__(self, api_url: str, internal_api_key: str, timeout_seconds: float) -> None:
        self.api_url = api_url.rstrip("/")
        self.internal_api_key = internal_api_key
        self.timeout_seconds = timeout_seconds

    async def report(self, event: UsageEvent) -> bool:
        """Post the same request ID on each retry so the API can deduplicate it."""

        if not self.api_url:
            return False
        payload = event.model_dump(mode="json")
        headers = {"X-GB-Internal-Key": self.internal_api_key}
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    response = await client.post(
                        f"{self.api_url}/internal/usage", json=payload, headers=headers
                    )
                    response.raise_for_status()
                return True
            except httpx.HTTPError:
                if attempt == 2:
                    return False
                await asyncio.sleep(0.2 * (attempt + 1))
        return False

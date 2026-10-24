"""Cached inference rate-card client with deterministic safe fallbacks."""

from __future__ import annotations

import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import httpx


@dataclass(frozen=True, slots=True)
class RateCard:
    input_per_mtok: Decimal
    output_per_mtok: Decimal
    base_fee: Decimal
    currency: str = "TDX"


DEFAULT_RATE = RateCard(
    input_per_mtok=Decimal("0.050000"),
    output_per_mtok=Decimal("0.200000"),
    base_fee=Decimal("0.001000"),
)


class RateClient:
    def __init__(self, pricing_url: str, ttl_seconds: int, timeout_seconds: float, mock: bool) -> None:
        self.pricing_url = pricing_url.rstrip("/")
        self.ttl_seconds = ttl_seconds
        self.timeout_seconds = timeout_seconds
        self.mock = mock
        self._cache: dict[str, tuple[float, RateCard]] = {}

    async def get(self, gpu_id: str) -> RateCard:
        now = time.monotonic()
        cached = self._cache.get(gpu_id)
        if cached and cached[0] > now:
            return cached[1]
        if self.mock or not self.pricing_url:
            self._cache[gpu_id] = (now + self.ttl_seconds, DEFAULT_RATE)
            return DEFAULT_RATE

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.get(f"{self.pricing_url}/rates/inference", params={"gpu_id": gpu_id})
                response.raise_for_status()
                body = response.json()
            rate = RateCard(
                input_per_mtok=Decimal(str(body["input_per_mtok"])),
                output_per_mtok=Decimal(str(body["output_per_mtok"])),
                base_fee=Decimal(str(body["base_fee"])),
                currency=str(body.get("currency", "TDX")),
            )
        except (httpx.HTTPError, KeyError, TypeError, ValueError, InvalidOperation):
            rate = DEFAULT_RATE
        self._cache[gpu_id] = (now + self.ttl_seconds, rate)
        return rate

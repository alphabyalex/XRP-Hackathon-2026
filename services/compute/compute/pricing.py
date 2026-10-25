"""Cached live rental prices. Numeric fixtures are confined to explicit mock mode."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

import httpx

from .models import ComputeError


@dataclass(frozen=True, slots=True)
class RateCard:
    input_per_mtok: Decimal
    output_per_mtok: Decimal
    base_fee: Decimal
    currency: str = "TDX"
    hourly_usd: Decimal | None = None
    updated_at: str | None = None
    source: str | None = None


DEFAULT_RATE = RateCard(
    input_per_mtok=Decimal("0.050000"),
    output_per_mtok=Decimal("0.200000"),
    base_fee=Decimal("0.001000"),
)


class RateClient:
    def __init__(
        self, pricing_url: str, ttl_seconds: int, timeout_seconds: float, mock: bool,
        api_url: str = "", internal_api_key: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # pricing_url remains in the constructor for existing explicit mock fixtures.
        # Live token-rate defaults are not a substitute for the rental catalog.
        self.pricing_url = pricing_url.rstrip("/")
        self.api_url = api_url.rstrip("/")
        self.internal_api_key = internal_api_key
        self.transport = transport
        self.ttl_seconds = ttl_seconds
        self.timeout_seconds = timeout_seconds
        self.mock = mock
        self._cache: dict[str, tuple[float, RateCard]] = {}

    async def get(self, gpu_id: str) -> RateCard:
        now = time.monotonic()
        cached = self._cache.get(gpu_id)
        if cached and cached[0] > now:
            return cached[1]
        if self.mock:
            self._cache[gpu_id] = (now + self.ttl_seconds, DEFAULT_RATE)
            return DEFAULT_RATE

        try:
            if not self.api_url:
                raise ValueError("Rental catalog is not configured")
            async with httpx.AsyncClient(timeout=min(self.timeout_seconds, 3), transport=self.transport) as client:
                response = await client.get(
                    f"{self.api_url}/catalog/gpus",
                    headers={"X-MS-Internal-Key": self.internal_api_key},
                )
                response.raise_for_status()
                body = response.json()
            gpu = next(item for item in body["gpus"] if item["id"] == gpu_id and item["status"] == "serving")
            prices = gpu["prices"]
            hourly = Decimal(str(prices["rentalUsdPerHour"]))
            economy = prices["economy"]
            source_hourly = Decimal(str(economy["usdPerHour"]))
            updated_at = str(economy["updatedAt"])
            updated = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            if updated.tzinfo is None:
                raise ValueError("Price time has no offset")
            age = (datetime.now(UTC) - updated).total_seconds()
            if not hourly.is_finite() or hourly <= 0 or hourly != source_hourly or not -300 <= age < 48 * 3600:
                raise ValueError("Live rental rate is unavailable or stale")
            rate = RateCard(
                input_per_mtok=Decimal("0"), output_per_mtok=Decimal("0"), base_fee=Decimal("0"),
                hourly_usd=hourly, updated_at=updated_at, source="GPU Economy median",
            )
        except (httpx.HTTPError, KeyError, TypeError, ValueError, InvalidOperation, StopIteration) as error:
            raise ComputeError("PRICING_UNAVAILABLE", "Live rental prices are not available. No request was started.", 503) from error
        # A cached rate must also expire when its publisher's observation becomes stale.
        lifetime = min(max(0, self.ttl_seconds), max(0, 48 * 3600 - age))
        self._cache[gpu_id] = (now + lifetime, rate)
        return rate

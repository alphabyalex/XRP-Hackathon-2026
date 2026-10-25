"""Process-wide state: the latest catalog snapshot, the fleet, and its live state."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import math

import httpx

from router import collectors
from router import config as C
from router.catalog import Offer, gpu_key, iso, now_utc, parse_time
from router.collectors.base import CollectContext
from router.fleet import FleetEntry, FleetState, GpuView, load_entries


@dataclass
class Service:
    offers: dict[str, Offer] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    catalog_as_of: str = ""
    entries: list[FleetEntry] = field(default_factory=list)
    state: FleetState = field(default_factory=FleetState)
    economy_rates: dict[str, dict] = field(default_factory=dict)
    _economy_checked: datetime | None = None

    def load_catalog(self, offers: list[Offer], errors: dict[str, str] | None = None) -> None:
        """Replace offers that were re-collected; keep the last good snapshot for the rest."""
        for o in offers:
            if C.FLEET_SOURCE == "mock" or o.priceSource == "live":
                self.offers[o.key] = o
        if C.FLEET_SOURCE != "mock":
            self.offers = {key: offer for key, offer in self.offers.items() if offer.priceSource == "live"}
        self.errors = errors or {}
        from router.optimizer import update_aws_prices
        update_aws_prices(self.offers.values())
        self.catalog_as_of = max((o.asOf for o in self.offers.values() if o.priceSource != "static"), default="")
        self.entries = load_entries(self.offers, self.economy_rates)
        executable = {e.offer.key for e in self.entries if e.offerFound}
        self.offers = {k: o.with_(executable=k in executable) for k, o in self.offers.items()}

    async def refresh_economy(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """Refresh one shared price snapshot in the background, never in a quote request."""
        if C.FLEET_SOURCE == "mock":
            return
        now = now_utc()
        if self._economy_checked and (now - self._economy_checked).total_seconds() < 15:
            return
        self._economy_checked = now
        try:
            async with httpx.AsyncClient(transport=transport, timeout=3) as client:
                response = await client.get(f"{C.API_URL}/gpu-prices")
                response.raise_for_status()
                data = response.json()
            published = parse_time(data["sourceUpdatedAt"])
            checked = parse_time(data["checkedAt"])
            if (data.get("stale") or data.get("source", {}).get("name") != "GPU Economy"
                    or not -300 <= (now - published).total_seconds() < 48 * 3600
                    or not -300 <= (now - checked).total_seconds() < 1800):
                self.economy_rates = {}
            else:
                rates = {}
                for gpu in data["gpus"]:
                    model = gpu_key(gpu.get("name") or gpu.get("id") or "")
                    try:
                        rate = float(gpu.get("rentalUsdPerHour"))
                    except (TypeError, ValueError):
                        continue
                    if model and math.isfinite(rate) and rate > 0:
                        rates[model] = {"pricePerGpuHourUsd": rate, "asOf": data["sourceUpdatedAt"],
                                        "checkedAt": data["checkedAt"], "source": "GPU Economy",
                                        "sourceUrl": gpu.get("sourceUrl"), "offerKey": f"gpu-economy#{gpu['id']}"}
                self.economy_rates = rates
            self.entries = load_entries(self.offers, self.economy_rates)
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            # Retain the last observed snapshot only while its publisher and check timestamps remain valid.
            self.entries = load_entries(self.offers, self.economy_rates)

    def collect(self, names: list[str] | None = None, ctx: CollectContext | None = None) -> None:
        offers, errors = collectors.run(names, ctx)
        self.load_catalog(offers, errors)

    def catalog(self, provider: str | None = None, gpu_model: str | None = None) -> list[Offer]:
        rows = [
            o
            for o in self.offers.values()
            if (provider is None or o.provider == provider) and (gpu_model is None or o.gpuModel == gpu_model)
        ]
        moonshift = [e.offer.with_(executable=True) for e in self.entries if e.offer.provider == "moonshift"
                     and (C.FLEET_SOURCE == "mock" or self.state.view(e, now_utc()).available)]
        if provider in (None, "moonshift") and gpu_model in (None, *[o.gpuModel for o in moonshift]):
            rows += [o for o in moonshift if gpu_model is None or o.gpuModel == gpu_model]
        return sorted(rows, key=lambda o: (o.provider, o.gpuModel, o.pricePerHourUsd, o.key))

    def entry(self, gpu_id: str) -> FleetEntry | None:
        return next((e for e in self.entries if e.id == gpu_id), None)

    def views(self, now: datetime | None = None) -> list[GpuView]:
        now = now or now_utc()
        return [self.state.view(e, now) for e in self.entries]

    def stamp(self) -> str:
        return self.catalog_as_of or iso(now_utc())


service = Service()

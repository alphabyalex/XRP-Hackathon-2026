"""Process-wide state: the latest catalog snapshot, the fleet, and its live state."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from router import collectors
from router.catalog import Offer, iso, now_utc
from router.collectors.base import CollectContext
from router.fleet import FleetEntry, FleetState, GpuView, load_entries


@dataclass
class Service:
    offers: dict[str, Offer] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    catalog_as_of: str = ""
    entries: list[FleetEntry] = field(default_factory=list)
    state: FleetState = field(default_factory=FleetState)

    def load_catalog(self, offers: list[Offer], errors: dict[str, str] | None = None) -> None:
        """Replace offers that were re-collected; keep the last good snapshot for the rest."""
        for o in offers:
            self.offers[o.key] = o
        self.errors = errors or {}
        self.catalog_as_of = max((o.asOf for o in self.offers.values() if o.priceSource != "static"), default="")
        self.entries = load_entries(self.offers)
        executable = {e.offer.key for e in self.entries if e.offerFound}
        self.offers = {k: o.with_(executable=k in executable) for k, o in self.offers.items()}

    def collect(self, names: list[str] | None = None, ctx: CollectContext | None = None) -> None:
        offers, errors = collectors.run(names, ctx)
        self.load_catalog(offers, errors)

    def catalog(self, provider: str | None = None, gpu_model: str | None = None) -> list[Offer]:
        rows = [
            o
            for o in self.offers.values()
            if (provider is None or o.provider == provider) and (gpu_model is None or o.gpuModel == gpu_model)
        ]
        moonshift = [e.offer.with_(executable=True) for e in self.entries if e.offer.provider == "moonshift"]
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

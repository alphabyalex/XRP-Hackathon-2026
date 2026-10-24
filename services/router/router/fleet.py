"""The fleet: the GPUs we can actually run on, joined with the catalog and their live state.

Static spec comes from config/fleet.json (or fleet.live.json). Live state per GPU: active jobs
and queue (router leases), booked windows (services/compute calendar plus the router's own rental
bookings), and availability (reclaimed, offline, stale or missing offer).
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import httpx

from router import config as C
from router.catalog import Availability, Offer, iso, make_offer, now_utc, parse_time

log = logging.getLogger("router.fleet")


@dataclass(frozen=True)
class FleetEntry:
    id: str
    label: str
    offer: Offer
    maxConcurrent: int  # noqa: N815
    moonshiftGpuId: str  # noqa: N815
    endpoint: str
    computeGpuId: str | None  # noqa: N815
    hardware: str
    offerFound: bool = True  # noqa: N815


@dataclass(frozen=True)
class GpuView:
    """Everything the optimizer needs about one GPU, as plain numbers relative to `now`."""

    id: str
    label: str
    provider: str
    region: str
    gpuModel: str  # noqa: N815
    hardware: str
    capacityType: str  # noqa: N815
    pool: str
    priceUsdcPerHour: float  # noqa: N815
    tokensPerSec: float  # noqa: N815
    interruptionRatePerHour: float  # noqa: N815
    warningWindowSeconds: float  # noqa: N815
    startupSeconds: float  # noqa: N815
    egressPerGbUsd: float  # noqa: N815
    maxConcurrent: int  # noqa: N815
    activeJobs: int  # noqa: N815
    queueWaitSeconds: float  # noqa: N815
    bookedWindows: tuple[tuple[float, float], ...]  # noqa: N815 (start, end) seconds from now
    available: bool
    executable: bool
    fresh: bool
    offerKey: str  # noqa: N815
    asOf: str  # noqa: N815
    reason: str | None = None


def _expand(s: str) -> str:
    return re.sub(r"\$\{(\w+)\}", lambda m: os.getenv(m.group(1), ""), s or "")


def load_entries(catalog: dict[str, Offer]) -> list[FleetEntry]:
    path = C.CONFIG_DIR / ("fleet.live.json" if C.FLEET_SOURCE == "live" else "fleet.json")
    raw = json.loads(path.read_text())["gpus"]
    out: list[FleetEntry] = []
    for g in raw:
        if "moonshift" in g:
            m = g["moonshift"]
            offer = make_offer(
                provider="moonshift",
                region=m.get("region", "moonshift"),
                instance_type=g["id"],
                gpu_model=m["gpuModel"],
                gpu_count=1,
                capacity_type="moonshift",
                price_per_hour_usd=float(m["pricePerHourUsdc"]),
                price_source="static",
                as_of=iso(now_utc()),
                availability=Availability("live"),
            )
            hardware, found = m.get("hardware", m["gpuModel"]), True
        else:
            offer = catalog.get(g["offer"])  # type: ignore[assignment]
            found = offer is not None
            if offer is None:
                prov, region, it, cap = g["offer"].split("#")
                offer = make_offer(
                    provider=prov,
                    region=region,
                    instance_type=it,
                    gpu_model="unknown",
                    gpu_count=1,
                    capacity_type=cap,
                    price_per_hour_usd=0.0,
                    price_source="fixture",
                    as_of="1970-01-01T00:00:00Z",
                    availability=Availability("none"),
                )
            hardware = f"{offer.gpuModel} ({offer.instanceType})"
        out.append(
            FleetEntry(
                id=g["id"],
                label=g["label"],
                offer=offer,
                maxConcurrent=int(g.get("maxConcurrent", 1)),
                moonshiftGpuId=g["moonshiftGpuId"],
                endpoint=_expand(g.get("endpoint", "")),
                computeGpuId=g.get("computeGpuId"),
                hardware=hardware,
                offerFound=found,
            )
        )
    return out


@dataclass
class Reclaim:
    reclaim_at: datetime
    returns_at: datetime
    reason: str


@dataclass
class FleetState:
    """Live, in-process state. Phase 4 mirrors leases into the state backend (SQLite / DynamoDB)."""

    active: dict[str, dict[str, datetime]] = field(default_factory=dict)  # gpu -> {job: expected end}
    reclaims: dict[str, Reclaim] = field(default_factory=dict)
    rentals: dict[str, list[tuple[datetime, datetime, str]]] = field(default_factory=dict)  # gpu -> windows
    compute_windows: dict[str, list[tuple[datetime, datetime]]] = field(default_factory=dict)
    compute_offline: set[str] = field(default_factory=set)
    _compute_fetched: datetime | None = None

    # ---- jobs and reclaims ----

    def start_job(self, gpu: str, job: str, expected_end: datetime) -> None:
        self.active.setdefault(gpu, {})[job] = expected_end

    def end_job(self, gpu: str, job: str) -> None:
        self.active.get(gpu, {}).pop(job, None)

    def reclaim(self, gpu: str, at: datetime, duration_s: float, reason: str) -> Reclaim:
        r = Reclaim(at, at + timedelta(seconds=duration_s), reason)
        self.reclaims[gpu] = r
        return r

    def reclaimed(self, gpu: str, now: datetime) -> Reclaim | None:
        r = self.reclaims.get(gpu)
        if r and now >= r.returns_at:
            del self.reclaims[gpu]
            return None
        return r

    def book(self, gpu: str, start: datetime, end: datetime, order_id: str) -> None:
        self.rentals.setdefault(gpu, []).append((start, end, order_id))

    # ---- services/compute calendar ----

    async def refresh_compute(
        self, entries: list[FleetEntry], transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        now = now_utc()
        if self._compute_fetched and (now - self._compute_fetched).total_seconds() < C.CALENDAR_CACHE_SECONDS:
            return
        self._compute_fetched = now
        ids = sorted({e.computeGpuId for e in entries if e.computeGpuId})
        if not ids:
            return
        headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
        try:
            async with httpx.AsyncClient(transport=transport, timeout=2.0, headers=headers) as http:
                gpus = (await http.get(f"{C.COMPUTE_URL}/gpus")).json()
                self.compute_offline = {g["id"] for g in gpus if g.get("state") == "OFFLINE"}
                for cid in ids:
                    r = await http.get(
                        f"{C.COMPUTE_URL}/gpus/{cid}/calendar",
                        params={"from": iso(now), "to": iso(now + timedelta(hours=24))},
                    )
                    self.compute_windows[cid] = [
                        (parse_time(w["start"]), parse_time(w["end"])) for w in r.json() if w.get("kind") == "BOOKED"
                    ]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            log.info("compute calendar unavailable (%s); using last known windows", type(e).__name__)

    # ---- views ----

    def windows(self, e: FleetEntry) -> list[tuple[datetime, datetime, str]]:
        out = [(s, en, "rental") for s, en, _ in self.rentals.get(e.id, [])]
        if e.computeGpuId:
            out += [(s, en, "compute") for s, en in self.compute_windows.get(e.computeGpuId, [])]
        return sorted(out)

    def view(self, e: FleetEntry, now: datetime) -> GpuView:
        jobs = self.active.get(e.id, {})
        if len(jobs) < e.maxConcurrent:
            wait = 0.0
        else:
            ends = sorted(jobs.values())
            wait = max(0.0, (ends[len(jobs) - e.maxConcurrent] - now).total_seconds())
        fresh = e.offer.priceSource == "static" or e.offer.age_seconds(now) <= C.CATALOG_MAX_AGE_SECONDS
        reason = None
        if not e.offerFound:
            reason = "OFFER_MISSING"
        elif self.reclaimed(e.id, now):
            reason = "RECLAIMED"
        elif e.computeGpuId and e.computeGpuId in self.compute_offline:
            reason = "OFFLINE"
        elif e.offer.availability.status == "none":
            reason = "NO_CAPACITY"
        elif not fresh:
            reason = "STALE_PRICE"
        windows = tuple(
            ((s - now).total_seconds(), (en - now).total_seconds()) for s, en, _ in self.windows(e) if en > now
        )
        return GpuView(
            id=e.id,
            label=e.label,
            provider=e.offer.provider,
            region=e.offer.region,
            gpuModel=e.offer.gpuModel,
            hardware=e.hardware,
            capacityType=e.offer.capacityType,
            pool=e.moonshiftGpuId,
            priceUsdcPerHour=e.offer.price_per_hour_usdc(),
            tokensPerSec=e.offer.tokensPerSec,
            interruptionRatePerHour=e.offer.interruptionRatePerHour,
            warningWindowSeconds=e.offer.warningWindowSeconds,
            startupSeconds=e.offer.startupSeconds,
            egressPerGbUsd=e.offer.egressPerGbUsd,
            maxConcurrent=e.maxConcurrent,
            activeJobs=len(jobs),
            queueWaitSeconds=wait,
            bookedWindows=windows,
            available=reason is None,
            executable=e.offerFound,
            fresh=fresh,
            offerKey=e.offer.key,
            asOf=e.offer.asOf,
            reason=reason,
        )

    def describe(self, e: FleetEntry, now: datetime) -> dict[str, Any]:
        v = self.view(e, now)
        r = self.reclaimed(e.id, now)
        return {
            "id": e.id,
            "label": e.label,
            "provider": v.provider,
            "region": v.region,
            "hardware": e.hardware,
            "gpuModel": v.gpuModel,
            "capacityType": v.capacityType,
            "offerKey": v.offerKey,
            "pricePerHourUsdc": f"{v.priceUsdcPerHour:.6f}",
            "tokensPerSec": v.tokensPerSec,
            "interruptible": v.interruptionRatePerHour > 0,
            "interruptionRatePerHour": v.interruptionRatePerHour,
            "warningWindowSeconds": v.warningWindowSeconds,
            "maxConcurrent": e.maxConcurrent,
            "moonshiftGpuId": e.moonshiftGpuId,
            "computeGpuId": e.computeGpuId,
            "endpoint": bool(e.endpoint),
            "asOf": v.asOf,
            "state": {
                "available": v.available,
                "reason": v.reason,
                "reclaimed": r is not None,
                "reclaimAt": iso(r.reclaim_at) if r else None,
                "returnsAt": iso(r.returns_at) if r else None,
                "activeJobs": v.activeJobs,
                "queueLength": max(0, v.activeJobs - e.maxConcurrent),
                "queueWaitSeconds": round(v.queueWaitSeconds, 1),
                "bookedWindows": [
                    {"start": iso(s), "end": iso(en), "source": src} for s, en, src in self.windows(e) if en > now
                ],
            },
        }

"""The fleet: the GPUs we can actually run on, joined with the catalog and their live state.

Static spec comes from config/fleet.json (or fleet.own.json, fleet.live.json). Live state per GPU: active jobs
and queue (router leases), booked windows (services/compute calendar plus the router's own rental
bookings), and availability (reclaimed, offline, stale or missing offer).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import httpx

from router import config as C
from router.catalog import Availability, Offer, gpu_key, iso, make_offer, now_utc, parse_time

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
    instanceId: str | None = None  # noqa: N815 (EC2 instance, for interruption events)
    capacityReservationId: str | None = None  # noqa: N815 (EC2 Capacity Block / reservation)
    benchmark: dict[str, Any] | None = None  # the market offer that sets this GPU's price
    planningObservation: dict[str, Any] | None = None  # measured end-to-end planning sample, not decoder throughput


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
    degraded: bool = False  # last good snapshot: price older than CATALOG_MAX_AGE but within the fallback
    spotUsdcPerHour: float = 0.0  # noqa: N815 (market spot benchmark; > 0 enables service levels)


def _expand(s: str) -> str:
    expanded = re.sub(
        r"\$\{(\w+)\}",
        lambda m: C.COMPUTE_URL if m.group(1) == "COMPUTE_URL" else os.getenv(m.group(1), ""),
        s or "",
    )
    return C.service_url(expanded)


FLEET_FILES = {"live": "fleet.live.json", "own": "fleet.own.json"}


def configured_own_nodes(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Enroll additional physical workers only from their verified runtime settings.

    Registry letters are identities, not hardware claims. Missing cost, model,
    capacity or measured model-specific throughput never inherits another node.
    """
    rows = list(raw)
    known = {row["id"] for row in rows}
    seen: set[str] = set()
    for letter in "abcdefgh":
        gpu_id = f"gpu-{letter}"
        prefix = gpu_id.upper().replace("-", "_")
        endpoint = os.getenv(f"{prefix}_VLLM_URL", "").strip().rstrip("/").removesuffix("/v1")
        if gpu_id in known:
            if endpoint:
                seen.add(endpoint)
            continue
        if not endpoint or endpoint in seen or os.getenv(f"{prefix}_MODE", "") != "real":
            continue
        card = os.getenv(f"{prefix}_CARD", "").strip()
        model = os.getenv(f"{prefix}_MODEL_ID", "").strip()
        try:
            resources = [int(os.getenv(f"{prefix}_{key}", "0")) for key in ("VRAM_GB", "VCPU", "RAM_GB", "STORAGE_GB")]
            if not card or not model or min(resources) <= 0 or C.own_rental_policy(gpu_id) is None:
                continue
        except ValueError:
            continue
        # Every newly admitted node needs its own observations, including cards
        # that happen to have a legacy hardware-wide planning estimate.
        moonshift: dict[str, Any] = {
            "gpuModel": gpu_key(card) or card,
            "hardware": f"{card} {resources[0]}GB (Akash Network)",
            "region": os.getenv(f"{prefix}_REGION", "akash"),
            "planningTokensPerSec": os.getenv(f"{prefix}_PLANNING_TOKENS_PER_SEC", "0"),
            "planningObservation": {
                "modelId": os.getenv(f"{prefix}_PLANNING_MODEL_ID", ""),
                "observedAt": os.getenv(f"{prefix}_PLANNING_OBSERVED_AT", ""),
                "source": "minimum_observed_end_to_end",
                "sampleCount": os.getenv(f"{prefix}_PLANNING_SAMPLE_COUNT", "0"),
                "receipt": f"contracts/compute/observed_gpu_{letter}_throughput.json",
                "scope": "Minimum of actual full-request observations including prefill and network time; a planning sample, not pure decoder throughput.",
            },
        }
        # Only a same-card AWS pair can affect service mode prices.
        key = gpu_key(card)
        if key:
            moonshift["benchmark"] = {"gpuModel": key, "provider": "aws"}
        rows.append({"id": gpu_id, "label": gpu_id.upper(), "moonshift": moonshift,
                     "maxConcurrent": 2, "moonshiftGpuId": gpu_id,
                     "computeGpuId": gpu_id, "endpoint": "${COMPUTE_URL}"})
        seen.add(endpoint)
    return rows


def benchmark_offer(
    catalog: dict[str, Offer], gpu_model: str, capacity: str = "on-demand", provider: str | None = None
) -> Offer | None:
    """The cheapest market offer for this GPU model and capacity type (optionally one provider), per GPU."""
    rows = [
        o
        for o in catalog.values()
        if o.provider != "moonshift"
        and (C.FLEET_SOURCE == "mock" or o.priceSource == "live")
        and (provider is None or o.provider == provider)
        and o.capacityType == capacity
        and o.availability.status != "none"
        and o.pricePerHourUsd > 0
        and (C.FLEET_SOURCE == "mock" or o.age_seconds(now_utc()) <= C.CATALOG_MAX_AGE_SECONDS * C.LAST_GOOD_FACTOR)
        and (gpu_key(o.gpuModel) or o.gpuModel) == gpu_model
    ]
    return min(rows, key=lambda o: (o.pricePerHourUsd / max(o.gpuCount, 1), o.key), default=None)


def per_gpu(o: Offer) -> float:
    return o.pricePerHourUsd / max(o.gpuCount, 1)


def load_entries(catalog: dict[str, Offer], economy_rates: dict[str, dict] | None = None) -> list[FleetEntry]:
    path = C.CONFIG_DIR / FLEET_FILES.get(C.FLEET_SOURCE, "fleet.json")
    raw = json.loads(path.read_text())["gpus"]
    if C.FLEET_SOURCE == "own":
        raw = configured_own_nodes(raw)
    out: list[FleetEntry] = []
    for g in raw:
        bench: dict[str, Any] | None = None
        observation: dict[str, Any] | None = None
        if "moonshift" in g:
            m = g["moonshift"]
            price = float(m.get("pricePerHourUsdc", 0)) if C.FLEET_SOURCE == "mock" else 0.0
            if m.get("benchmark"):
                # "T4" (any provider) or {"gpuModel": "T4", "provider": "aws"}: the on-demand offer sets the
                # price; the spot offer, when there is one, sets the Pausable service level (optimizer.py).
                spec = m["benchmark"] if isinstance(m["benchmark"], dict) else {"gpuModel": m["benchmark"]}
                b = benchmark_offer(catalog, spec["gpuModel"], "on-demand", spec.get("provider"))
                if b is not None:
                    price = per_gpu(b)
                    bench = {"offerKey": b.key, "pricePerGpuHourUsd": round(price, 6), "asOf": b.asOf}
                    spot = benchmark_offer(catalog, spec["gpuModel"], "spot", spec.get("provider"))
                    if spot is not None:
                        bench |= {"spotOfferKey": spot.key, "spotPricePerGpuHourUsd": round(per_gpu(spot), 6)}
            if C.FLEET_SOURCE != "mock":
                comparison = bench
                economy = (economy_rates or {}).get(m["gpuModel"])
                valid = False
                if economy:
                    now = now_utc()
                    valid = (0 < economy["pricePerGpuHourUsd"]
                             and -300 <= (now - parse_time(economy["asOf"])).total_seconds() < 48 * 3600
                             and -300 <= (now - parse_time(economy["checkedAt"])).total_seconds() < 1800)
                # A market benchmark does not authorize our rental rate. The
                # configured lease-plus-margin policy remains valid until changed.
                policy = C.own_rental_policy(g["id"])
                bench = {**policy, "marketComparison": economy if valid else None, "awsComparison": comparison} if policy else None
                price = float(policy["pricePerGpuHourUsd"]) if policy else 0.0
            offer = make_offer(
                provider="moonshift",
                region=m.get("region", "moonshift"),
                instance_type=g["id"],
                gpu_model=m["gpuModel"],
                gpu_count=1,
                capacity_type="moonshift",
                price_per_hour_usd=price,
                price_source="live" if bench else "static",
                as_of=bench["asOf"] if bench else iso(now_utc()),
                availability=Availability("live" if C.FLEET_SOURCE == "mock" or bench else "none"),
            )
            hardware = m.get("hardware", m["gpuModel"])
            found = C.FLEET_SOURCE == "mock" or bench is not None
            if C.FLEET_SOURCE != "mock" and m.get("planningTokensPerSec") is not None:
                # A newly deployed model can lack a hardware-wide planning
                # estimate. Use its own actual observed sample, never another
                # card or another model's throughput.
                try:
                    measured = float(m["planningTokensPerSec"])
                    record = m["planningObservation"]
                    canonical = os.getenv(f"{g['id'].upper().replace('-', '_')}_MODEL_ID", "")
                    valid_sample = (math.isfinite(measured) and measured > 0
                                    and record["modelId"] == canonical and bool(canonical)
                                    and record["source"] == "minimum_observed_end_to_end"
                                    and int(record.get("sampleCount", 0)) >= 2
                                    and (now_utc() - parse_time(record["observedAt"])).total_seconds() >= -300)
                    if not valid_sample:
                        raise ValueError("Planning sample does not describe the deployed model")
                    observation = record
                    offer = offer.with_(tokensPerSec=measured)
                except (ValueError, TypeError, KeyError):
                    found = False
                    offer = offer.with_(tokensPerSec=0, availability=Availability("none"))
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
                instanceId=g.get("instanceId"),
                capacityReservationId=g.get("capacityReservationId"),
                benchmark=bench,
                planningObservation=observation,
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
    # Moonshift GPUs apps/api does not list (endpoint missing or failing its health check).
    unlisted: set[str] = field(default_factory=set)
    healthy_pools: set[str] = field(default_factory=set)
    _listing_fetched: datetime | None = None

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

    async def refresh_listing(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """Only a passing endpoint health check admits a live pool. Unreachable API fails closed."""
        now = now_utc()
        if self._listing_fetched and (now - self._listing_fetched).total_seconds() < C.CALENDAR_CACHE_SECONDS:
            return
        self._listing_fetched = now
        try:
            async with httpx.AsyncClient(transport=transport, timeout=2.0) as http:
                response = await http.get(f"{C.API_URL}/gpus-health")
                response.raise_for_status()
                rows = response.json()
            self.unlisted = {r["gpuId"] for r in rows if not r.get("ok")}
            self.healthy_pools = {r["gpuId"] for r in rows if r.get("ok")}
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            if C.FLEET_SOURCE != "mock":
                self.healthy_pools.clear()
            log.info("gpu listing unavailable (%s); using the last known", type(e).__name__)

    async def refresh_compute(
        self, entries: list[FleetEntry], transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        await self.refresh_listing(transport)
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
                response = await http.get(f"{C.COMPUTE_URL}/gpus")
                response.raise_for_status()
                gpus = response.json()
                self.compute_offline = {
                    g["id"] for g in gpus
                    if g.get("state") == "OFFLINE" or (C.FLEET_SOURCE != "mock" and g.get("simulated"))
                }
                if C.FLEET_SOURCE != "mock":
                    self.compute_offline.update(set(ids) - {g["id"] for g in gpus})
                for cid in ids:
                    r = await http.get(
                        f"{C.COMPUTE_URL}/gpus/{cid}/calendar",
                        params={"from": iso(now), "to": iso(now + timedelta(hours=24))},
                    )
                    self.compute_windows[cid] = [
                        (parse_time(w["start"]), parse_time(w["end"])) for w in r.json() if w.get("kind") == "BOOKED"
                    ]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            if C.FLEET_SOURCE != "mock":
                self.compute_offline.update(ids)
            log.info("compute calendar unavailable (%s); using last known windows", type(e).__name__)

    # ---- views ----

    def windows(self, e: FleetEntry, exclude: set[str] | None = None) -> list[tuple[datetime, datetime, str]]:
        out = [(s, en, "rental") for s, en, oid in self.rentals.get(e.id, []) if not exclude or oid not in exclude]
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
        # Fresh: within CATALOG_MAX_AGE. Last good snapshot: up to 4x that, still usable but degraded
        # (availability treated as unknown, the optimizer adds risk). Older: excluded.
        age = 0.0 if C.FLEET_SOURCE == "mock" and e.offer.provider == "moonshift" else e.offer.age_seconds(now)
        if (e.benchmark or {}).get("priceBasis") == "akash_lease_plus_margin":
            # This is a configured business policy, not a feed whose timestamp
            # should be reset or aged out as though it were a market observation.
            fresh, degraded = e.offerFound, False
        elif (e.benchmark or {}).get("source") == "GPU Economy":
            checked_age = (now - parse_time(e.benchmark["checkedAt"])).total_seconds()
            fresh = age < 48 * 3600 and checked_age < 1800
            degraded = False
        else:
            fresh = age <= C.CATALOG_MAX_AGE_SECONDS
            degraded = not fresh and age <= C.CATALOG_MAX_AGE_SECONDS * C.LAST_GOOD_FACTOR
        reason = None
        if not e.offerFound:
            reason = "OFFER_MISSING"
        elif C.FLEET_SOURCE != "mock" and not e.endpoint:
            reason = "NO_ENDPOINT"
        elif C.FLEET_SOURCE != "mock" and e.moonshiftGpuId not in self.healthy_pools:
            reason = "NOT_LISTED"
        elif e.offer.provider == "moonshift" and e.moonshiftGpuId in self.unlisted:
            reason = "NOT_LISTED"
        elif self.reclaimed(e.id, now):
            reason = "RECLAIMED"
        elif e.computeGpuId and e.computeGpuId in self.compute_offline:
            reason = "OFFLINE"
        elif e.offer.availability.status == "none":
            reason = "NO_CAPACITY"
        elif not fresh and not degraded:
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
            executable=e.offerFound if C.FLEET_SOURCE == "mock" else reason is None,
            fresh=fresh,
            offerKey=e.offer.key,
            asOf=e.offer.asOf,
            reason=reason,
            degraded=degraded,
            spotUsdcPerHour=(float(e.offer.pricePerHourUsd) if (e.benchmark or {}).get("priceBasis") == "akash_lease_plus_margin" or (e.benchmark or {}).get("source") == "GPU Economy"
                            else float((e.benchmark or {}).get("spotPricePerGpuHourUsd", 0.0))),
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
            "pricePerHourUsdc": f"{v.priceUsdcPerHour:.6f}" if e.offerFound else None,
            "pricingSource": (e.benchmark or {}).get("source"),
            "priceUpdatedAt": (e.benchmark or {}).get("asOf"),
            "tokensPerSec": v.tokensPerSec,
            "tokensPerSecSource": "observed_end_to_end_planning_sample" if e.planningObservation else "hardware_planning_estimate",
            "planningObservation": e.planningObservation,
            "interruptible": v.interruptionRatePerHour > 0,
            "interruptionRatePerHour": v.interruptionRatePerHour,
            "warningWindowSeconds": v.warningWindowSeconds,
            "maxConcurrent": e.maxConcurrent,
            "moonshiftGpuId": e.moonshiftGpuId,
            "computeGpuId": e.computeGpuId,
            "endpoint": bool(e.endpoint),
            "benchmark": e.benchmark,
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

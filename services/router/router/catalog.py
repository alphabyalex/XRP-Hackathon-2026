"""The offer catalog: every GPU capacity we can price, across providers.

An Offer is one provider + region + instance type + capacity type. Collectors (router/collectors)
produce offers; the fleet (router/fleet.py) marks the ones we can actually run on as executable.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, cast, get_args

from router import config as C

CapacityType = Literal["spot", "on-demand", "reserved", "marketplace", "moonshift"]
PriceSource = Literal["live", "static", "fixture"]
CAPACITY_TYPES = frozenset(get_args(CapacityType))
PRICE_SOURCES = frozenset(get_args(PriceSource))


@dataclass(frozen=True)
class Availability:
    status: Literal["live", "likely", "unknown", "none"]
    count: int | None = None  # live capacity count when the provider reports one
    score: int | None = None  # AWS Spot placement score 1..10


@dataclass(frozen=True)
class Offer:
    provider: str
    region: str
    instanceType: str  # noqa: N815 (contract field names are camelCase)
    gpuModel: str  # noqa: N815
    gpuCount: int  # noqa: N815
    capacityType: CapacityType  # noqa: N815
    pricePerHourUsd: float  # noqa: N815 (whole instance)
    priceSource: PriceSource  # noqa: N815
    availability: Availability
    interruptionRatePerHour: float  # noqa: N815
    warningWindowSeconds: float  # noqa: N815
    tokensPerSec: float  # noqa: N815 (per instance, for Moonshift's model)
    asOf: str  # noqa: N815
    executable: bool = False
    egressPerGbUsd: float = 0.0  # noqa: N815
    startupSeconds: float = 0.0  # noqa: N815
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.provider}#{self.region}#{self.instanceType}#{self.capacityType}"

    @property
    def interruptible(self) -> bool:
        return self.interruptionRatePerHour > 0

    def price_per_hour_usdc(self) -> float:
        """What Moonshift charges: external capacity carries the margin, Moonshift GPUs do not."""
        if self.provider == "moonshift":
            return self.pricePerHourUsd
        return self.pricePerHourUsd * (1 + C.margin())

    def age_seconds(self, now: datetime) -> float:
        return (now - parse_time(self.asOf)).total_seconds()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["key"] = self.key
        d["interruptible"] = self.interruptible
        d["pricePerHourUsdc"] = round(self.price_per_hour_usdc(), 6)
        d["pricePerGpuHourUsd"] = round(self.pricePerHourUsd / max(1, self.gpuCount), 6)
        return d

    def with_(self, **changes: Any) -> Offer:
        return replace(self, **changes)


def now_utc() -> datetime:
    return datetime.now(UTC)


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(s: str) -> datetime:
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=UTC)


# ---- Shared estimates --------------------------------------------------------------------


def gpu_key(name: str) -> str | None:
    """Map a provider's GPU name ('NVIDIA T4', 'A10 (24 GB PCIe)', 'RTX 4090') onto gpu_perf keys."""
    perf = C.load_json("gpu_perf.json")
    if name in perf["tokensPerSec"]:
        return name
    if name in perf["aliases"]:
        return str(perf["aliases"][name])
    upper = name.upper()
    # Longest key first so "A100" is not read as "A10" and "L40S" not as "L40".
    for key in sorted(perf["tokensPerSec"], key=len, reverse=True):
        if key.upper() in upper:
            return key
    return None


def tokens_per_sec(gpu_model: str) -> float:
    """Single-stream decode speed. A request runs on one GPU, so multi-GPU instances do not add speed."""
    return float(C.load_json("gpu_perf.json")["tokensPerSec"].get(gpu_model, 0.0))


def rate_from_monthly_fraction(f: float) -> float:
    hours = float(C.load_json("interruption_model.json")["hoursPerMonth"])
    f = min(max(f, 0.0), 0.99)
    return -math.log(1 - f) / hours


def aws_spot_rate(band_index: int | None, placement_score: int | None) -> float:
    """Spot Advisor band blended with the placement score (config/interruption_model.json)."""
    model = C.load_json("interruption_model.json")
    bands = {b["index"]: b["monthlyFraction"] for b in model["awsAdvisorBands"]}
    f = (
        bands.get(band_index, model["unknownBandMonthlyFraction"])
        if band_index is not None
        else model["unknownBandMonthlyFraction"]
    )
    mult = float(model["unknownScoreMultiplier"])
    if placement_score is not None:
        for row in model["placementScoreMultiplier"]:  # ordered by minScore descending
            if placement_score >= row["minScore"]:
                mult = float(row["multiplier"])
                break
    return rate_from_monthly_fraction(f) * mult


def make_offer(
    *,
    provider: str,
    region: str,
    instance_type: str,
    gpu_model: str,
    gpu_count: int,
    capacity_type: str,
    price_per_hour_usd: float,
    price_source: str,
    as_of: str,
    availability: Availability | None = None,
    interruption_rate: float | None = None,
    extra: dict[str, Any] | None = None,
) -> Offer:
    """Fill the provider defaults (warning window, egress, start-up, interruption) in one place."""
    if capacity_type not in CAPACITY_TYPES or price_source not in PRICE_SOURCES:
        raise ValueError(f"bad capacity type {capacity_type!r} or price source {price_source!r}")
    p = C.provider(provider)
    if capacity_type in C.load_json("interruption_model.json")["nonInterruptibleCapacityTypes"]:
        rate = 0.0
    elif interruption_rate is not None:
        rate = interruption_rate
    else:
        rate = float(p.get("spotRatePerHour") or 0.0)
    return Offer(
        provider=provider,
        region=region,
        instanceType=instance_type,
        gpuModel=gpu_model,
        gpuCount=gpu_count,
        capacityType=cast(CapacityType, capacity_type),
        pricePerHourUsd=round(price_per_hour_usd, 6),
        priceSource=cast(PriceSource, price_source),
        availability=availability or Availability("unknown"),
        interruptionRatePerHour=rate,
        warningWindowSeconds=float(p["warningWindowSeconds"]) if rate > 0 or provider == "moonshift" else 0.0,
        tokensPerSec=tokens_per_sec(gpu_model),
        asOf=as_of,
        egressPerGbUsd=float(p["egressPerGbUsd"]),
        startupSeconds=float(p["startupSeconds"]),
        extra=extra or {},
    )

"""POST /quote: the three-mode quote for one order, from the current catalog snapshot and fleet state."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field

from router import config as C
from router import optimizer as O
from router.catalog import iso
from router.errors import RouterError
from router.fleet import GpuView


class ConstraintsIn(BaseModel):
    gpuModel: str | None = None  # noqa: N815
    region: str | None = None
    excludeProviders: list[str] = Field(default_factory=list)  # noqa: N815


class OrderIn(BaseModel):
    kind: str = "inference"
    tokens: int | None = Field(default=None, ge=1, le=1_000_000_000)
    requests: int | list[Any] | None = None  # a count (quote) or the prompts themselves (order)
    maxTokens: int | None = Field(default=None, ge=1, le=8192)  # noqa: N815 (per request)
    minutes: int | None = Field(default=None, ge=1)  # the fleet's own limit is checked in check_size
    deadlineSeconds: float | None = Field(default=None, gt=0)  # noqa: N815
    budgetUsdc: str | float | None = None  # noqa: N815
    constraints: ConstraintsIn = Field(default_factory=ConstraintsIn)

    def request_count(self) -> int:
        if isinstance(self.requests, list):
            return max(1, len(self.requests))
        return max(1, int(self.requests or 1))


def to_spec(o: OrderIn) -> O.OrderSpec:
    cons = O.Constraints(o.constraints.gpuModel, o.constraints.region, tuple(sorted(o.constraints.excludeProviders)))
    budget = float(o.budgetUsdc) if o.budgetUsdc not in (None, "") else None
    if o.kind == "inference":
        n = o.request_count()
        tokens = o.tokens or (o.maxTokens or 256) * n
        return O.OrderSpec(
            "inference",
            tokens=tokens,
            requests=n,
            deadlineSeconds=o.deadlineSeconds,
            budgetUsdc=budget,
            constraints=cons,
        )
    if o.kind == "rental":
        if not o.minutes:
            raise RouterError(422, "INVALID_ORDER", "rental orders need minutes")
        return O.OrderSpec(
            "rental", minutes=o.minutes, deadlineSeconds=o.deadlineSeconds, budgetUsdc=budget, constraints=cons
        )
    raise RouterError(422, "INVALID_ORDER", "kind must be inference or rental")


def spec_dict(spec: O.OrderSpec) -> dict[str, Any]:
    return {
        "kind": spec.kind,
        "tokens": spec.tokens if spec.kind == "inference" else None,
        "requests": spec.requests if spec.kind == "inference" else None,
        "minutes": spec.total_units * C.SLOT_MINUTES if spec.kind == "rental" else None,
        "deadlineSeconds": spec.deadlineSeconds,
        "budgetUsdc": O.usdc(spec.budgetUsdc) if spec.budgetUsdc is not None else None,
        "constraints": {
            k: v
            for k, v in {
                "gpuModel": spec.constraints.gpuModel,
                "region": spec.constraints.region,
                "excludeProviders": list(spec.constraints.excludeProviders),
            }.items()
            if v
        },
    }


def limits(views: list[GpuView]) -> dict[str, Any]:
    """The largest task the fleet takes: what every GPU finishes in MAX_TASK_DAYS."""
    hours = O.max_gpu_hours(views)
    tps = min((v.tokensPerSec for v in views if v.executable and v.tokensPerSec > 0), default=0.0)
    return {"maxGpuHours": round(hours, 2), "maxTokens": int(hours * 3600 * tps), "days": C.MAX_TASK_DAYS}


def check_size(spec: O.OrderSpec, views: list[GpuView]) -> None:
    """Refuse a task the fleet cannot finish in MAX_TASK_DAYS (never shrink it to fit)."""
    cap = O.max_gpu_hours(views)
    if cap > 0 and O.gpu_hours(spec, views) > cap + 1e-9:
        raise RouterError(422, "TOO_LARGE", f"Max {cap:g} GPU-hours")


def quote(
    spec: O.OrderSpec, views: list[GpuView], alternatives: Counter[str], catalog_as_of: str, now: datetime
) -> tuple[dict[str, Any], dict[O.Mode, O.Choice]]:
    check_size(spec, views)
    choices, plans = O.choose_for(spec, views)
    if not plans:
        raise RouterError(503, "NO_CAPACITY", "no executable GPU is available for this order")
    order = spec_dict(spec)
    qid = "q_" + hashlib.sha256(json.dumps([order, catalog_as_of], sort_keys=True).encode()).hexdigest()[:8]
    body = {
        "quoteId": qid,
        "order": order,
        "catalogAsOf": catalog_as_of,
        "default": "balanced",
        "options": {m: O.plan_dict(choices[m], spec, now) for m in O.MODES},
        "alternativesConsidered": dict(sorted(alternatives.items())),
        "plansEvaluated": plans,
        "limits": limits(views),
        "why": None,
        "validUntil": iso(now + timedelta(seconds=C.QUOTE_VALID_SECONDS)),
        "asOf": iso(now),
    }
    return body, choices

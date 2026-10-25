"""The order optimizer: place an order on up to 3 GPUs (any providers) for Cheapest, Balanced or Fastest.

Pure and deterministic: the same order and the same fleet views (catalog snapshot + live state)
always give the same plans. docs/ROUTER.md explains the model; the short version:

  per part on GPU g with work w:
    run   = w / tokensPerSec (inference) or w minutes (rental)
    start = first time >= queue wait where startup + run + guard clears every booked window
    p     = 1 - exp(-rate x run hours)                     probability g is reclaimed mid-run
    resume_s = resume latency (new worker start + re-reading prompt and partial answer)
               + lost progress since the last checkpoint     (never zero)
    egress   = checkpoint GB x g's egress price, only when the resume would cross providers
    cost  = price x run + p x (price x resume_s + egress)
    eta   = start + startup + run + p x resume_s
  plan: cost = sum, eta = max, risk = 1 - prod(1 - p)

  cheapest: min cost s.t. deadline, budget     fastest: min eta s.t. budget (and deadline if any plan meets it)
  balanced: Pareto frontier of feasible plans, both axes min-max normalized over the frontier,
            pick the plan closest to the ideal corner (0, 0) by Euclidean distance (the knee).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from router import config as C
from router.catalog import iso
from router.fleet import GpuView

Mode = Literal["cheapest", "balanced", "fastest"]
MODES: tuple[Mode, ...] = ("cheapest", "balanced", "fastest")


@dataclass(frozen=True)
class Constraints:
    gpuModel: str | None = None  # noqa: N815
    region: str | None = None
    excludeProviders: tuple[str, ...] = ()  # noqa: N815


@dataclass(frozen=True)
class OrderSpec:
    kind: Literal["inference", "rental"]
    tokens: int = 0  # inference: total output tokens across all requests
    requests: int = 1  # inference: number of prompts (1 = a single streamed reply, never split)
    minutes: int = 0  # rental
    deadlineSeconds: float | None = None  # noqa: N815
    budgetUsdc: float | None = None  # noqa: N815
    constraints: Constraints = field(default_factory=Constraints)

    @property
    def unit(self) -> str:
        return "tokens" if self.kind == "inference" else "minutes"

    @property
    def total_units(self) -> int:
        """Indivisible pieces: requests for inference, 5 minute slots for rentals."""
        if self.kind == "inference":
            return max(1, self.requests)
        return max(1, math.ceil(self.minutes / C.SLOT_MINUTES))

    @property
    def size(self) -> float:
        return float(self.tokens) if self.kind == "inference" else float(self.total_units * C.SLOT_MINUTES)


@dataclass(frozen=True)
class Params:
    resume_latency_s: float = C.RESUME_LATENCY_SECONDS
    checkpoint_every_tokens: int = C.CHECKPOINT_EVERY_TOKENS
    checkpoint_flush_s: float = C.CHECKPOINT_FLUSH_SECONDS
    rental_checkpoint_s: float = C.RENTAL_CHECKPOINT_SECONDS
    booking_guard_s: float = C.BOOKING_GUARD_SECONDS
    inference_checkpoint_gb: float = float(C.providers()["checkpointSizeGb"])
    rental_checkpoint_gb: float = float(C.providers().get("rentalCheckpointSizeGb", 2.0))
    max_parts: int = C.MAX_PARTS
    split_steps: int = C.SPLIT_STEPS


@dataclass(frozen=True)
class Part:
    gpu: GpuView
    units: int
    work: float
    start_s: float
    run_s: float
    eta_s: float
    cost: float
    p_interrupt: float
    resume_s: float
    egress_cost: float


@dataclass(frozen=True)
class Plan:
    parts: tuple[Part, ...]
    cost: float
    eta_s: float
    risk: float

    @property
    def signature(self) -> tuple[tuple[str, int], ...]:
        return tuple((p.gpu.id, p.units) for p in self.parts)


class NoCapacity(Exception):
    pass


# ---- Per part model ----------------------------------------------------------------------


def earliest_start(g: GpuView, busy_s: float, guard_s: float) -> float:
    """First start >= queue wait so that [start, start + busy + guard] misses every booked window."""
    t = g.queueWaitSeconds
    for start, end in sorted(g.bookedWindows):
        if end <= t:
            continue
        if t + busy_s + guard_s <= start:
            break
        t = max(t, end)
    return t


def fallback_for(g: GpuView, others: Sequence[GpuView]) -> GpuView | None:
    """Where g's work would most likely resume: the cheapest other available GPU (then by id)."""
    alt = [o for o in others if o.id != g.id]
    return min(alt, key=lambda o: (o.priceUsdcPerHour, o.id)) if alt else None


def part_metrics(g: GpuView, units: int, order: OrderSpec, pool: Sequence[GpuView], params: Params) -> Part:
    if order.kind == "inference":
        work = order.tokens * units / order.total_units
        run_s = work / max(g.tokensPerSec, 1e-9)
        ckpt_interval_s = params.checkpoint_every_tokens / max(g.tokensPerSec, 1e-9)
        ckpt_gb = params.inference_checkpoint_gb
    else:
        work = float(units * C.SLOT_MINUTES)
        run_s = work * 60.0
        ckpt_interval_s = params.rental_checkpoint_s
        ckpt_gb = params.rental_checkpoint_gb
    rate = g.interruptionRatePerHour * (2.0 if g.degraded else 1.0)  # last good snapshot: assume worse
    startup = g.startupSeconds * (2.0 if g.degraded else 1.0)
    start = earliest_start(g, startup + run_s, params.booking_guard_s if g.bookedWindows else 0.0)
    p = 1.0 - math.exp(-rate * run_s / 3600.0)
    fb = fallback_for(g, pool)
    # With a warning window long enough to flush, progress is saved at the signal; otherwise we lose
    # on average half a checkpoint interval. Either way the new worker must start and re-read.
    lost_s = 0.0 if g.warningWindowSeconds >= params.checkpoint_flush_s else ckpt_interval_s / 2.0
    resume_s = params.resume_latency_s + (fb.startupSeconds if fb else startup) + lost_s
    crosses = fb is not None and fb.provider != g.provider
    egress = ckpt_gb * g.egressPerGbUsd if crosses else 0.0
    price_s = g.priceUsdcPerHour / 3600.0
    cost = price_s * run_s + p * (price_s * resume_s + egress)
    eta = start + startup + run_s + p * resume_s
    return Part(g, units, work, start, run_s, eta, cost, p, resume_s, egress)


# ---- Plans -------------------------------------------------------------------------------


def compositions(total: int, k: int) -> Iterable[tuple[int, ...]]:
    """All ways to write total as k positive integers (ordered)."""
    for cuts in itertools.combinations(range(1, total), k - 1):
        bounds = (0, *cuts, total)
        yield tuple(bounds[i + 1] - bounds[i] for i in range(k))


def scale(units: int, comp: tuple[int, ...]) -> tuple[int, ...] | None:
    """Map a composition of the share grid onto real units (largest remainder), each part >= 1."""
    grid = sum(comp)
    if grid == units:
        return comp
    raw = [units * c / grid for c in comp]
    base = [math.floor(r) for r in raw]
    for i in sorted(range(len(comp)), key=lambda i: (-(raw[i] - base[i]), i))[: units - sum(base)]:
        base[i] += 1
    return tuple(base) if all(b >= 1 for b in base) else None


def candidates(views: Sequence[GpuView], order: OrderSpec) -> list[GpuView]:
    c = order.constraints
    return sorted(
        (
            v
            for v in views
            if v.available
            and v.executable
            and (v.fresh or v.degraded)
            and v.tokensPerSec > 0
            and (c.gpuModel is None or v.gpuModel == c.gpuModel)
            and (c.region is None or v.region == c.region)
            and v.provider not in c.excludeProviders
        ),
        key=lambda v: v.id,
    )


def enumerate_plans(order: OrderSpec, views: Sequence[GpuView], params: Params | None = None) -> list[Plan]:
    params = params or Params()
    pool = candidates(views, order)
    units = order.total_units
    single_stream = order.kind == "inference" and order.requests <= 1  # one streamed reply: never split
    max_k = 1 if single_stream else min(params.max_parts, units, len(pool))
    grid = min(units, params.split_steps)
    cache: dict[tuple[str, int], Part] = {}
    seen: set[tuple[tuple[str, int], ...]] = set()
    plans: list[Plan] = []
    for k in range(1, max_k + 1):
        for gpus in itertools.combinations(pool, k):
            for comp in compositions(grid, k):
                real = scale(units, comp)
                if real is None:
                    continue
                sig = tuple((g.id, u) for g, u in zip(gpus, real, strict=True))
                if sig in seen:
                    continue
                seen.add(sig)
                parts = []
                for g, u in zip(gpus, real, strict=True):
                    key = (g.id, u)
                    if key not in cache:
                        cache[key] = part_metrics(g, u, order, pool, params)
                    parts.append(cache[key])
                cost = sum(p.cost for p in parts)
                eta = max(p.eta_s for p in parts)
                risk = 1.0 - math.prod(1.0 - p.p_interrupt for p in parts)
                plans.append(Plan(tuple(parts), cost, eta, risk))
    return plans


def _within(plan: Plan, order: OrderSpec, deadline: bool = True) -> bool:
    if order.budgetUsdc is not None and plan.cost > order.budgetUsdc + 1e-12:
        return False
    if deadline and order.deadlineSeconds is not None and plan.eta_s > order.deadlineSeconds:
        return False
    return True


def frontier(plans: Sequence[Plan]) -> list[Plan]:
    """Pareto frontier on (eta, cost): sorted by eta, keep plans strictly cheaper than all faster ones."""
    out: list[Plan] = []
    best_cost = math.inf
    for p in sorted(plans, key=lambda p: (p.eta_s, p.cost, p.signature)):
        if p.cost < best_cost - 1e-15:
            out.append(p)
            best_cost = p.cost
    return out


def knee(front: Sequence[Plan]) -> tuple[Plan, dict[str, float]]:
    costs = [p.cost for p in front]
    etas = [p.eta_s for p in front]
    c_lo, c_hi, t_lo, t_hi = min(costs), max(costs), min(etas), max(etas)

    def norm(v: float, lo: float, hi: float) -> float:
        return 0.0 if hi - lo < 1e-15 else (v - lo) / (hi - lo)

    scored = []
    for p in front:
        nc, nt = norm(p.cost, c_lo, c_hi), norm(p.eta_s, t_lo, t_hi)
        scored.append((math.hypot(nc, nt), p.cost, p.eta_s, p.signature, p, nc, nt))
    d, _, _, _, best, nc, nt = min(scored, key=lambda s: s[:4])
    return best, {
        "normalizedCost": round(nc, 4),
        "normalizedTime": round(nt, 4),
        "distance": round(d, 4),
        "frontierSize": len(front),
    }


@dataclass
class Choice:
    mode: Mode
    plan: Plan | None
    reason: str | None = None
    score: dict[str, float] | None = None
    deadline_met: bool = True


def choose(plans: Sequence[Plan], order: OrderSpec) -> dict[Mode, Choice]:
    feasible = [p for p in plans if _within(p, order)]
    out: dict[Mode, Choice] = {}
    if feasible:
        out["cheapest"] = Choice("cheapest", min(feasible, key=lambda p: (p.cost, p.eta_s, p.signature)))
        out["fastest"] = Choice("fastest", min(feasible, key=lambda p: (p.eta_s, p.cost, p.signature)))
        best, score = knee(frontier(feasible))
        out["balanced"] = Choice("balanced", best, score=score)
        return out
    reason = "NO_CAPACITY" if not plans else "NO_PLAN_MEETS_DEADLINE_AND_BUDGET"
    out["cheapest"] = Choice("cheapest", None, reason)
    out["balanced"] = Choice("balanced", None, reason)
    within_budget = [p for p in plans if _within(p, order, deadline=False)]
    if within_budget:  # Fastest is bound by budget only: show the soonest it can be done.
        fastest = min(within_budget, key=lambda p: (p.eta_s, p.cost, p.signature))
        out["fastest"] = Choice("fastest", fastest, deadline_met=False)
    else:
        out["fastest"] = Choice("fastest", None, reason)
    return out


# ---- Output ------------------------------------------------------------------------------


def usdc(v: float) -> str:
    return f"{max(0.0, v):.6f}"


def part_dict(p: Part, order: OrderSpec) -> dict[str, Any]:
    g = p.gpu
    d: dict[str, Any] = {
        "gpuId": g.id,
        "label": g.label,
        "provider": g.provider,
        "region": g.region,
        "hardware": g.hardware,
        "capacityType": g.capacityType,
        "moonshiftGpuId": g.pool,
        "share": round(p.units / order.total_units, 4),
        "work": round(p.work, 3),
        "unit": order.unit,
        "startsInSeconds": round(p.start_s, 1),
        "runSeconds": round(p.run_s, 1),
        "etaSeconds": round(p.eta_s, 1),
        "priceUsdc": usdc(p.cost),
        "interruptible": g.interruptionRatePerHour > 0,
        "interruptionRisk": round(p.p_interrupt, 6),
        "resumeSeconds": round(p.resume_s, 2),
        "egressUsdc": usdc(p.egress_cost),
    }
    if order.kind == "inference":
        d["requests"] = p.units
    else:
        d["slots"] = p.units
    return d


def plan_dict(c: Choice, order: OrderSpec, now: datetime) -> dict[str, Any]:
    if c.plan is None:
        return {"mode": c.mode, "feasible": False, "reason": c.reason}
    p = c.plan
    providers = list(dict.fromkeys(part.gpu.provider for part in p.parts))
    d: dict[str, Any] = {
        "mode": c.mode,
        "feasible": True,
        "priceUsdc": usdc(p.cost),
        "etaSeconds": round(p.eta_s, 1),
        "completesAt": iso(now + timedelta(seconds=p.eta_s)),
        "interruptionRisk": round(p.risk, 6),
        "providers": providers,
        "parts": [part_dict(x, order) for x in p.parts],
    }
    if c.score is not None:
        d["score"] = c.score
    if not c.deadline_met:
        d["deadlineMet"] = False
    return d


def best_for(order: OrderSpec, mode: Mode, views: Sequence[GpuView], params: Params | None = None) -> Choice:
    """One mode only (used to re-place remaining work after a move)."""
    return choose(enumerate_plans(order, views, params), order)[mode]

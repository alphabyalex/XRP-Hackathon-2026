"""Replay synthetic orders against the fleet and compare routing policies. A simulation.

    python scripts/benchmark.py                 # mock catalog (fixtures), writes docs/ROUTER.md
    python scripts/benchmark.py --from-store    # the stored catalog snapshot (live prices if collected)
    python scripts/benchmark.py --no-write      # print only

Policies: the optimizer in each mode (cheapest, balanced, fastest), "AWS only" (balanced, but only
AWS capacity), and naive round-robin (next GPU in turn, one GPU per order, restart from zero when
interrupted). Interruptions are sampled from each GPU's interruptionRatePerHour; because real spot
rates almost never fire on short jobs, the run is repeated with every rate multiplied by STRESS.
"""

from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from router import optimizer as O  # noqa: E402
from router.catalog import now_utc  # noqa: E402
from router.collectors.base import CollectContext  # noqa: E402
from router.fleet import GpuView  # noqa: E402
from router.service import Service  # noqa: E402
from router.store import catalog_store  # noqa: E402

ORDERS = 1000
SEED = 7
STRESS = 500.0
MEAN_GAP_S = 150.0  # mean seconds between order arrivals (about 40% fleet utilization)
DOC = Path(__file__).resolve().parents[3] / "docs" / "ROUTER.md"
START, END = "<!-- benchmark:start -->", "<!-- benchmark:end -->"


@dataclass
class Order:
    arrive: float
    spec: O.OrderSpec


def synth_orders(rng: random.Random) -> list[Order]:
    t, out = 0.0, []
    for _ in range(ORDERS):
        t += rng.expovariate(1 / MEAN_GAP_S)
        if rng.random() < 0.6:
            n = rng.choice([1, 1, 1, 2, 4, 8, 16])
            tokens = n * rng.choice([128, 256, 512, 1024, 2048])
            spec = O.OrderSpec("inference", tokens=tokens, requests=n)
            nominal = tokens / 40.0  # on one T4
        else:
            minutes = rng.choice([5, 10, 15, 30, 60])
            spec = O.OrderSpec("rental", minutes=minutes)
            nominal = minutes * 60.0
        if rng.random() < 0.5:  # half the orders carry a deadline of 4x their single-T4 run time
            spec = replace(spec, deadlineSeconds=max(120.0, 4 * nominal))
        out.append(Order(t, spec))
    return out


class Fleet:
    """Slots per GPU with busy-until times, turned into GpuViews with queue waits."""

    def __init__(self, views: list[GpuView]) -> None:
        self.base = {v.id: v for v in views}
        self.busy: dict[str, list[float]] = {v.id: [0.0] * v.maxConcurrent for v in views}

    def views(self, now: float, allowed: set[str] | None = None) -> list[GpuView]:
        out = []
        for gid, v in self.base.items():
            if allowed is not None and gid not in allowed:
                continue
            wait = max(0.0, min(self.busy[gid]) - now)
            out.append(replace(v, queueWaitSeconds=wait, activeJobs=sum(b > now for b in self.busy[gid])))
        return out

    def occupy(self, gid: str, start: float, end: float) -> None:
        slots = self.busy[gid]
        i = min(range(len(slots)), key=lambda k: slots[k])
        slots[i] = max(slots[i], end, start)


def run_part(
    fleet: Fleet,
    part: O.Part,
    now: float,
    rng: random.Random,
    stress: float,
    resume: bool,
    spec: O.OrderSpec,
    mode: str,
    allowed: set[str] | None,
    stats: dict,
) -> tuple[float, float]:
    """Simulate one part (possibly interrupted and moved). Returns (cost, finish time)."""
    g = part.gpu
    start = now + part.start_s
    run_s, cost, t = part.run_s, 0.0, start + g.startupSeconds
    remaining = run_s
    gpu = g
    hops = 0
    while True:
        rate = gpu.interruptionRatePerHour * stress
        cut = rng.expovariate(rate / 3600) if rate > 0 else math.inf
        price_s = gpu.priceUsdcPerHour / 3600
        if cut >= remaining or hops >= 3:
            cost += price_s * remaining
            stats["work"][gpu.provider] += remaining
            fleet.occupy(gpu.id, t, t + remaining)
            return cost, t + remaining
        stats["interruptions"] += 1
        cost += price_s * cut
        stats["work"][gpu.provider] += cut
        fleet.occupy(gpu.id, t, t + cut)
        t += cut
        hops += 1
        if resume:
            stats["moves"] += 1
            lost = (
                0.0
                if gpu.warningWindowSeconds >= 1.0
                else (16 / max(gpu.tokensPerSec, 1) if spec.kind == "inference" else 30.0)
            )
            remaining = remaining - cut + lost
        else:
            stats["restarts"] += 1
            remaining = run_s  # start over
        others = [v for v in fleet.views(t, allowed) if v.id != gpu.id]
        if not others:
            others = fleet.views(t, allowed)
        nxt = min(
            others,
            key=lambda v: (
                v.priceUsdcPerHour
                if mode == "cheapest"
                else v.queueWaitSeconds + remaining * 40 / max(v.tokensPerSec, 1),
                v.id,
            ),
        )
        t += nxt.queueWaitSeconds + nxt.startupSeconds + 2.0  # resume latency
        if spec.kind == "inference":
            remaining = remaining * gpu.tokensPerSec / max(nxt.tokensPerSec, 1e-9)
        gpu = nxt


def simulate(views: list[GpuView], orders: list[Order], policy: str, stress: float) -> dict:
    rng = random.Random(SEED)
    fleet = Fleet(views)
    allowed = {v.id for v in views if v.provider == "aws"} if policy == "aws_only" else None
    stats: dict = {"interruptions": 0, "moves": 0, "restarts": 0, "work": Counter()}
    total_cost, times, rr = 0.0, [], 0
    ids = sorted(fleet.base)
    for o in orders:
        if policy == "round_robin":
            gid = ids[rr % len(ids)]
            rr += 1
            v = [x for x in fleet.views(o.arrive) if x.id == gid][0]
            part = O.part_metrics(v, o.spec.total_units, o.spec, fleet.views(o.arrive), O.Params())
            parts, mode = [part], "cheapest"
        else:
            mode = "balanced" if policy == "aws_only" else policy
            plans = O.enumerate_plans(o.spec, fleet.views(o.arrive, allowed))
            choice = O.choose(plans, o.spec)[mode]  # type: ignore[index]
            parts = list(choice.plan.parts) if choice.plan else []
        finish = o.arrive
        for part in parts:
            c, f = run_part(fleet, part, o.arrive, rng, stress, policy != "round_robin", o.spec, mode, allowed, stats)
            total_cost += c
            finish = max(finish, f)
        times.append(finish - o.arrive)
    times.sort()
    work = stats["work"]
    total_work = sum(work.values()) or 1
    return {
        "policy": policy,
        "cost": total_cost,
        "p50": statistics.median(times),
        "p99": times[min(len(times) - 1, int(0.99 * len(times)))],
        "interruptions": stats["interruptions"],
        "moves": stats["moves"],
        "restarts": stats["restarts"],
        "share": {p: round(100 * w / total_work, 1) for p, w in sorted(work.items(), key=lambda x: -x[1])},
    }


def table(rows: list[dict]) -> str:
    out = [
        "| Policy | Total cost (USDC) | p50 completion | p99 completion | Interruptions | Resumed (moves) "
        "| Restarts | Work share by provider |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        share = ", ".join(f"{p} {s}%" for p, s in r["share"].items())
        out.append(
            f"| {r['policy']} | {r['cost']:.4f} | {r['p50']:.1f} s | {r['p99']:.1f} s | {r['interruptions']} | "
            f"{r['moves']} | {r['restarts']} | {share} |"
        )
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-store", action="store_true", help="use the stored catalog snapshot")
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()
    svc = Service()
    source = "mock catalog (fixtures)"
    if args.from_store and (stored := catalog_store().latest()):
        svc.load_catalog(stored)
        source = "stored catalog snapshot (live prices where collected)"
    else:
        svc.collect(ctx=CollectContext())
    now = now_utc()
    views = [v for v in svc.views(now) if v.available]
    orders = synth_orders(random.Random(SEED))
    sections = []
    for label, stress in (("catalog interruption rates", 1.0), (f"stress: every rate x {STRESS:g}", STRESS)):
        rows = [
            simulate(views, orders, p, stress) for p in ("cheapest", "balanced", "fastest", "aws_only", "round_robin")
        ]
        sections.append(f"**{label}**\n\n{table(rows)}")
        print(f"\n{label}\n{table(rows)}")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    body = (
        f"{START}\nSimulation, {ORDERS} synthetic orders (60% inference, 40% rentals of 5 to 60 minutes, half with a "
        "deadline of 4x their single-T4 run time, "
        f"Poisson arrivals every {MEAN_GAP_S:g} s on average), seed {SEED}, {source}, "
        f"{len(views)} GPUs, run {stamp}. Reproduce: `python services/router/scripts/benchmark.py`.\n\n"
        + "\n\n".join(sections)
        + f"\n{END}"
    )
    if not args.no_write:
        text = DOC.read_text() if DOC.exists() else ""
        if START in text and END in text:
            text = text[: text.index(START)] + body + text[text.index(END) + len(END) :]
        else:
            text = text + "\n## Benchmark\n\n" + body + "\n"
        DOC.write_text(text)
        print(f"\nwrote {DOC}")


if __name__ == "__main__":
    main()

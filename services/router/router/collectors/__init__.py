"""Collector registry: name -> (function, schedule group).

Schedule groups match the EventBridge Scheduler rules in infra/template.yaml and the local
background task: spot every 5 minutes, other providers every 15, on-demand list prices daily.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from router import config as C
from router.catalog import Offer
from router.collectors import aws, aws_public, others
from router.collectors.base import CollectContext


@dataclass(frozen=True)
class Collector:
    name: str
    provider: str
    group: str  # spot | providers | on_demand
    fn: Callable[[CollectContext], list[Offer]]


COLLECTORS: list[Collector] = [
    Collector("aws_public", "aws", "spot", aws_public.collect),
    Collector("aws_spot", "aws", "spot", aws.collect_spot),
    Collector("aws_on_demand", "aws", "on_demand", aws.collect_on_demand),
    Collector("azure", "azure", "providers", others.azure),
    Collector("gcp", "gcp", "providers", others.gcp),
    Collector("oracle", "oracle", "providers", others.oracle),
    Collector("lambda", "lambda", "providers", others.lambda_cloud),
    Collector("runpod", "runpod", "providers", others.runpod),
    Collector("vast", "vast", "providers", others.vast),
    Collector("static", "coreweave", "on_demand", others.static),
]

BY_NAME = {c.name: c for c in COLLECTORS}


def run(names: list[str] | None = None, ctx: CollectContext | None = None) -> tuple[list[Offer], dict[str, str]]:
    """Run collectors; one failing provider never blocks the rest. Returns (offers, errors by name)."""
    ctx = ctx or CollectContext()
    offers: list[Offer] = []
    errors: dict[str, str] = {}
    for c in COLLECTORS:
        if names is not None and c.name not in names:
            continue
        if C.FLEET_SOURCE != "mock" and not ctx.is_live(c.name):
            continue
        if c.name == "aws_public" and not ctx.is_live(c.name):
            continue
        try:
            offers.extend(c.fn(ctx))
        except Exception as e:  # noqa: BLE001 (a provider outage must not stop the catalog)
            errors[c.name] = f"{type(e).__name__}: {e}"[:200]
    return offers, errors

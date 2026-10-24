"""Collector scheduling.

AWS (STATE_BACKEND=dynamodb): EventBridge Scheduler invokes the collector Lambdas (router/lambdas.py)
on the intervals in config.COLLECT_INTERVALS; the router only reloads the catalog table every minute.
Local: this background task runs the same collector groups on the same intervals in-process and
writes the same shapes to SQLite.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from router import config as C
from router.catalog import Offer
from router.collectors import COLLECTORS, run
from router.collectors.base import CollectContext
from router.secrets import provider_secrets
from router.store import CatalogStore

log = logging.getLogger("router.scheduler")

RELOAD_SECONDS = 60.0
TICK_SECONDS = 5.0


def collect_group(
    group: str, store: CatalogStore, ctx: CollectContext | None = None
) -> tuple[list[Offer], dict[str, str]]:
    """Run one schedule group (spot | providers | on_demand), store offers and raw responses."""
    ctx = ctx or CollectContext(secrets=provider_secrets())
    names = [c.name for c in COLLECTORS if c.group == group]
    offers, errors = run(names, ctx)
    if offers:
        store.put_offers(offers)
    for source, body in ctx.raw:
        try:
            store.append_raw(source, body, ctx.now)
        except Exception as e:  # noqa: BLE001 (history is best effort; the catalog itself is stored)
            errors[f"history:{source}"] = type(e).__name__
    if errors:
        log.warning("collect %s: %d offers, errors: %s", group, len(offers), sorted(errors))
    return offers, errors


async def initial_load(service: Any, store: CatalogStore) -> None:
    """Before serving: the last good snapshot, then (local) one fresh run of every group."""
    last_good = await asyncio.to_thread(store.latest)
    if last_good:
        service.load_catalog(last_good)
    if C.STATE_BACKEND == "dynamodb":
        return
    errors: dict[str, str] = {}
    for group in C.COLLECT_INTERVALS:
        offers, errs = await asyncio.to_thread(collect_group, group, store)
        errors.update(errs)
        service.load_catalog(offers, errors)


async def run_forever(service: Any, store: CatalogStore) -> None:
    if C.STATE_BACKEND == "dynamodb":
        while True:  # the Lambdas collect; we only read
            try:
                service.load_catalog(await asyncio.to_thread(store.latest))
            except Exception as e:  # noqa: BLE001
                log.warning("catalog reload failed: %s", type(e).__name__)
            await asyncio.sleep(RELOAD_SECONDS)
    start = time.monotonic()  # initial_load just ran every group
    next_due = {g: start + interval for g, interval in C.COLLECT_INTERVALS.items()}
    while True:
        now = time.monotonic()
        for group, interval in C.COLLECT_INTERVALS.items():
            if now >= next_due[group]:
                next_due[group] = now + interval
                try:
                    offers, errors = await asyncio.to_thread(collect_group, group, store)
                    service.load_catalog(offers, {**service.errors, **errors})
                except Exception as e:  # noqa: BLE001 (keep the loop alive)
                    log.warning("collect %s failed: %s", group, type(e).__name__)
        await asyncio.sleep(TICK_SECONDS)

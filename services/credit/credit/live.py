"""Live rescoring of connected wallets.

The WebSocket monitor (credit/ws.py, Quicknode testnet) calls on_tx for every validated transaction
touching a watched address. For each borrower whose connected wallet it is, we refetch the wallet's
history (until the new tx is in it), rebuild the combined profile, diff the factors against the last
profile we served, and emit PROFILE_CHANGED: to GET /events and to the api, which drops its cached
profile and pushes the event to /borrow over SSE.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from credit.history import Tx, normalize
from credit.link import linker
from credit.monitor import Monitor, event, iso
from credit.xrpl_client import XrplClient

log = logging.getLogger("credit.live")

# Network the borrowers (and their Moonshift loans) live on.
BORROWER_NETWORK = os.getenv("CREDIT_BORROWER_NETWORK", "devnet")

Build = Callable[..., Awaitable[dict[str, Any]]]


def activity(network: str, address: str, t: Tx) -> dict[str, Any]:
    """One line of the wallet's activity feed."""
    x = t.delivered_xrp() if t.type == "Payment" else None
    iou = t.delivered_iou() if t.type == "Payment" and x is None else None
    out = t.account == address
    return {
        "at": iso(t.date) or iso(datetime.now(UTC)),
        "type": t.type,
        "direction": "out" if out else "in",
        "amount": f"{x.normalize():f}" if x is not None else (f"{iou[2].normalize():f}" if iou else None),
        "currency": "XRP" if x is not None else (iou[0] if iou else None),
        "counterparty": (t.destination if out else t.account) if t.destination else None,
        "txHash": t.hash,
        "network": network,
        "ok": t.ok,
    }


def changes(before: dict[str, Any] | None, after: dict[str, Any]) -> list[dict[str, Any]]:
    """Factors whose value or points moved. A value change shows even when the band (points) did not."""
    if not before:
        return []
    out = []
    for k, fa in after["features"].items():
        fb = before["features"].get(k)
        if fb is None or (fb["value"] == fa["value"] and fb["points"] == fa["points"]):
            continue
        out.append(
            {
                "feature": k,
                "before": fb["value"],
                "after": fa["value"],
                "pointsBefore": fb["points"],
                "pointsAfter": fa["points"],
                "delta": fa["points"] - fb["points"],
            }
        )
    return sorted(out, key=lambda c: (-abs(c["delta"]), c["feature"]))


class Rescorer:
    def __init__(self, monitor: Monitor, build: Build) -> None:
        self.monitor, self.build = monitor, build
        self.last: dict[str, dict[str, Any]] = {}  # borrower -> last profile served
        self._tasks: set[asyncio.Task[None]] = set()

    def remember(self, borrower: str, body: dict[str, Any]) -> None:
        self.last[borrower] = body

    def on_tx(self, network: str, address: str, t: Tx, via: str) -> None:
        for borrower in linker().borrowers_for_wallet(network, address):
            task = asyncio.get_running_loop().create_task(self.rescore(borrower, network, address, t, via))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def rescore(self, borrower: str, network: str, address: str, t: Tx, via: str) -> None:
        started = datetime.now(UTC)
        try:
            before = self.last.get(borrower) or await self.build(BORROWER_NETWORK, borrower)
            # A validated tx can take a moment to show in account_tx; wait for it (about 6 s max).
            client = XrplClient(network)
            for _ in range(8):
                page = await client.account_tx(address, refresh=True)
                if any(normalize(e).hash == t.hash for e in page.transactions):
                    break
                await asyncio.sleep(0.75)
            after = await self.build(BORROWER_NETWORK, borrower, refresh_link=True)
        except Exception:  # keep the monitor alive; the next tx rescores again
            log.exception("rescore failed for %s", borrower)
            return
        diff = changes(before, after)
        ev = event(
            "PROFILE_CHANGED",
            "warn" if after["score"] < before["score"] else "info",
            network,
            address,
            t.hash,
            f"Score {before['score']} to {after['score']} after {t.type}",
            via,
            at=datetime.now(UTC),
        )
        ev.update(
            {
                "borrower": borrower,
                "borrowerNetwork": BORROWER_NETWORK,
                "score": after["score"],
                "grade": after["grade"],
                "confidence": after["confidence"],
                "scoreBefore": before["score"],
                "gradeBefore": before["grade"],
                "changes": diff,
                "activity": activity(network, address, t),
                "rescoreMs": int((datetime.now(UTC) - started).total_seconds() * 1000),
            }
        )
        self.monitor.emit(ev)
        log.info(
            "rescored %s after %s %s: %s -> %s (%d factor changes, %d ms)",
            borrower, t.type, t.hash[:8], before["score"], after["score"], len(diff), ev["rescoreMs"],
        )


async def recent_activity(network: str, address: str, n: int = 8) -> list[dict[str, Any]]:
    """Newest first, from the (cached) account_tx page."""
    page = await XrplClient(network).account_tx(address)
    txs = [normalize(e) for e in page.transactions]
    txs.sort(key=lambda t: (t.ledger_index or 0, t.hash), reverse=True)
    return [activity(network, address, t) for t in txs[:n]]

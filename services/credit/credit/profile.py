"""Build a credit profile (contracts/credit/profile.json) from live XRPL reads."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from credit import config as C
from credit import features as F
from credit import scoring
from credit.history import Tx, normalize
from credit.xrpl_client import XrplClient


def iso(d: datetime | None) -> str | None:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


async def fetch_history(
    client: XrplClient, address: str, refresh: bool, now: datetime
) -> tuple[F.History, dict[str, Any]]:
    info = await client.account_info(address, refresh=refresh)
    lines = await client.account_lines(address, refresh=refresh)
    page = await client.account_tx(address, refresh=refresh)
    first_raw = await client.first_tx(address)
    txs: list[Tx] = [normalize(e) for e in page.transactions]
    first = normalize(first_raw) if first_raw else None
    dates = [t.date for t in txs if t.date]
    meta = {
        "txFetched": len(txs),
        "pages": page.pages,
        "truncated": page.truncated,
        "firstTxAt": iso(first.date if first else None),
        "lastTxAt": iso(max(dates) if dates else None),
        "ledgerIndex": info.get("ledger_index") or info.get("ledger_current_index"),
    }
    hist = F.History(address, txs, len(lines), first, now, C.lender_addresses())
    return hist, meta


def assemble(
    network: str,
    address: str,
    source: str,
    hist: F.History,
    history_meta: dict[str, Any],
) -> dict[str, Any]:
    s = scoring.score(F.extract(hist))
    reasons = list(s.reasons)
    if history_meta["truncated"]:
        reasons.append("HISTORY_TRUNCATED")
    return {
        "address": address,
        "network": network,
        "readOnly": C.NETWORKS[network].read_only,
        "source": source,
        "simulated": False,
        "score": s.score,
        "grade": s.grade,
        "confidence": s.confidence,
        "features": s.features,
        "reasons": reasons,
        "scorecard": {
            "version": scoring.scorecard()["version"],
            "basePoints": scoring.scorecard()["basePoints"],
            "rawPoints": s.raw_points,
            "cap": s.cap,
        },
        "history": history_meta,
        "portfolio": None,
        "ownership": None,
        "asOf": iso(hist.now),
    }


async def build(
    network: str,
    address: str,
    refresh: bool = False,
    client: XrplClient | None = None,
    now: datetime | None = None,
) -> tuple[dict[str, Any], F.History]:
    client = client or XrplClient(network)
    now = now or datetime.now(UTC)
    hist, meta = await fetch_history(client, address, refresh, now)
    return assemble(network, address, client.source, hist, meta), hist

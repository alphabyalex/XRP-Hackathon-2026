"""Normalize XRPL transactions from any source into one shape.

Handles account_tx API v1 entries ({tx, meta}), API v2 entries ({tx_json, meta, hash}) and
Quicknode Streams ledger transactions (flat tx fields with hash and metaData).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from credit import config as C

DROPS_PER_XRP = Decimal(1_000_000)


@dataclass
class Tx:
    hash: str
    type: str
    account: str
    destination: str | None
    date: datetime | None
    ledger_index: int | None
    result: str
    memos: list[dict[str, Any]]  # decoded; each has at least "type" when it is a Moonshift memo
    tx: dict[str, Any] = field(repr=False)
    meta: dict[str, Any] = field(repr=False)

    @property
    def ok(self) -> bool:
        return self.result == "tesSUCCESS"

    def memo(self, memo_type: str) -> dict[str, Any] | None:
        return next((m for m in self.memos if m.get("type") == memo_type), None)

    def delivered_xrp(self) -> Decimal | None:
        """XRP actually delivered by a Payment, or None when it moved an issued token."""
        amt = self.meta.get("delivered_amount", self.meta.get("DeliveredAmount", self.tx.get("Amount")))
        if isinstance(amt, str) and amt.isdigit():
            return Decimal(amt) / DROPS_PER_XRP
        return None

    def delivered_iou(self) -> tuple[str, str, Decimal] | None:
        amt = self.meta.get("delivered_amount", self.tx.get("Amount"))
        if isinstance(amt, dict) and "value" in amt:
            return amt.get("currency", ""), amt.get("issuer", ""), Decimal(str(amt["value"]))
        return None

    def balance_change(self, address: str) -> tuple[Decimal, Decimal] | None:
        """(XRP balance before, after) for address, from the AccountRoot node in the metadata."""
        for node in self.meta.get("AffectedNodes", []):
            body = node.get("ModifiedNode") or node.get("CreatedNode")
            if not body or body.get("LedgerEntryType") != "AccountRoot":
                continue
            final = body.get("FinalFields") or body.get("NewFields") or {}
            if final.get("Account") != address or "Balance" not in final:
                continue
            after = Decimal(final["Balance"]) / DROPS_PER_XRP
            prev = (body.get("PreviousFields") or {}).get("Balance")
            before = Decimal(prev) / DROPS_PER_XRP if prev is not None else after
            if "CreatedNode" in node:
                before = Decimal(0)
            return before, after
        return None


def ripple_to_datetime(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds + C.RIPPLE_EPOCH_OFFSET, UTC)


def _decode_hex(h: str | None) -> str:
    if not h:
        return ""
    try:
        return bytes.fromhex(h).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return ""


# Before the Moonshift rename, packages/xrpl wrote GB_ (Groundbreak) memo types. Those loans are
# still on testnet, so GB_REPAY etc. are read as MS_REPAY etc. The original stays in legacyType.
LEGACY_PREFIX = "GB_"


def _canonical(memo: dict[str, Any]) -> dict[str, Any]:
    t = memo.get("type")
    if isinstance(t, str) and t.startswith(LEGACY_PREFIX):
        return {**memo, "type": "MS_" + t[len(LEGACY_PREFIX) :], "legacyType": t}
    return memo


def decode_memos(tx: dict[str, Any]) -> list[dict[str, Any]]:
    """packages/xrpl writes MemoType "text/plain" and MemoData JSON like {"type": "MS_REPAY", ...}.

    A memo whose MemoType itself is an MS_ name (no JSON body) is also accepted.
    """
    out: list[dict[str, Any]] = []
    for wrapper in tx.get("Memos", []) or []:
        m = wrapper.get("Memo", {})
        data, mtype = _decode_hex(m.get("MemoData")), _decode_hex(m.get("MemoType"))
        try:
            parsed = json.loads(data) if data else None
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            out.append(_canonical(parsed))
        elif mtype.startswith(LEGACY_PREFIX) or mtype.startswith("MS_"):
            out.append(_canonical({"type": mtype, "data": data}))
        elif data:
            out.append({"text": data})
    return out


def normalize(entry: dict[str, Any], close_time_iso: str | None = None) -> Tx:
    # account_tx v2 / v1, WebSocket subscription messages ("transaction"), or a flat Streams tx.
    tx = entry.get("tx_json") or entry.get("tx") or entry.get("transaction") or entry
    meta = entry.get("meta") or entry.get("metaData") or tx.get("metaData") or {}
    if isinstance(meta, str):  # binary meta is never requested, but never crash on it
        meta = {}
    h = entry.get("hash") or tx.get("hash") or ""
    date: datetime | None = None
    if isinstance(tx.get("date"), int):
        date = ripple_to_datetime(tx["date"])
    elif entry.get("close_time_iso") or close_time_iso:
        iso = (entry.get("close_time_iso") or close_time_iso or "").replace("Z", "+00:00")
        date = datetime.fromisoformat(iso)
    ledger = entry.get("ledger_index") or tx.get("ledger_index") or tx.get("inLedger")
    return Tx(
        hash=h,
        type=tx.get("TransactionType", ""),
        account=tx.get("Account", ""),
        destination=tx.get("Destination"),
        date=date,
        ledger_index=int(ledger) if ledger is not None else None,
        result=meta.get("TransactionResult", ""),
        memos=decode_memos(tx),
        tx=tx,
        meta=meta,
    )

"""A tiny fake rippled JSON-RPC server for tests, plus builders for realistic tx entries."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from credit import config as C


def ripple_time(iso: str) -> int:
    return (
        int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(UTC).timestamp())
        - C.RIPPLE_EPOCH_OFFSET
    )


def memo(data: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "Memo": {
                "MemoType": b"text/plain".hex().upper(),
                "MemoData": json.dumps(data).encode().hex().upper(),
            }
        }
    ]


def account_root(address: str, before: int | None, after: int) -> dict[str, Any]:
    node: dict[str, Any] = {
        "LedgerEntryType": "AccountRoot",
        "FinalFields": {"Account": address, "Balance": str(after)},
    }
    if before is not None and before != after:
        node["PreviousFields"] = {"Balance": str(before)}
    return {"ModifiedNode": node}


def entry(
    h: str,
    tx_type: str,
    account: str,
    at: str,
    ledger: int,
    *,
    destination: str | None = None,
    amount: Any = None,
    memos: list[dict[str, Any]] | None = None,
    nodes: list[dict[str, Any]] | None = None,
    result: str = "tesSUCCESS",
    **extra: Any,
) -> dict[str, Any]:
    """An account_tx entry in API v1 shape (tx + meta)."""
    tx: dict[str, Any] = {
        "hash": h,
        "TransactionType": tx_type,
        "Account": account,
        "date": ripple_time(at),
        "ledger_index": ledger,
        "Fee": "12",
        **extra,
    }
    if destination:
        tx["Destination"] = destination
    if amount is not None:
        tx["Amount"] = amount
    if memos:
        tx["Memos"] = memos
    meta: dict[str, Any] = {"TransactionResult": result, "AffectedNodes": nodes or []}
    if amount is not None and tx_type == "Payment":
        meta["delivered_amount"] = amount
    return {"tx": tx, "meta": meta, "validated": True}


@dataclass
class FakeLedger:
    accounts: dict[str, dict[str, Any]] = field(default_factory=dict)  # address -> account_info AccountData
    lines: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    txs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # newest first
    page_size: int = 2
    rate_limit_first: int = 0  # answer this many requests with HTTP 429 first
    ledger_index: int = 1000
    requests: list[dict[str, Any]] = field(default_factory=list)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if self.rate_limit_first > 0:
            self.rate_limit_first -= 1
            return httpx.Response(429)
        method, params = body["method"], body["params"][0]
        return httpx.Response(200, json={"result": self.result(method, params)})

    def result(self, method: str, p: dict[str, Any]) -> dict[str, Any]:
        acct = p.get("account", "")
        if acct not in self.accounts:
            return {"error": "actNotFound", "status": "error"}
        if method == "account_info":
            return {"account_data": self.accounts[acct], "ledger_index": self.ledger_index, "validated": True}
        if method == "account_lines":
            return {"account": acct, "lines": self.lines.get(acct, [])}
        if method == "account_tx":
            items = list(self.txs.get(acct, []))
            if p.get("forward"):
                items.reverse()
            limit = min(p.get("limit", 200), self.page_size)
            start = int(p.get("marker", {}).get("seq", 0)) if p.get("marker") else 0
            page = items[start : start + limit]
            out: dict[str, Any] = {"account": acct, "transactions": page}
            if start + limit < len(items):
                out["marker"] = {"ledger": 0, "seq": start + limit}
            return out
        return {"error": "unknownCmd"}

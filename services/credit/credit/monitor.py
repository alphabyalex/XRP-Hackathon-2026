"""Live credit monitoring: turn borrower transactions into credit events.

Transactions arrive from Quicknode Streams (credit/streams.py, primary) or a WebSocket
subscription (credit/ws.py, fallback). Both call Monitor.handle_tx, so events are identical
whichever path delivered them. Each event goes to GET /events and to api POST /internal/credit-events.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx

from credit import config as C
from credit.db import Store, store
from credit.events import EventBus, bus
from credit.history import Tx

log = logging.getLogger("credit.monitor")

Poster = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


def iso(d: datetime | None) -> str | None:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def event(
    kind: str,
    severity: str,
    network: str,
    address: str,
    tx_hash: str | None,
    detail: str,
    via: str,
    *,
    amount: str | None = None,
    currency: str | None = None,
    ledger_index: int | None = None,
    at: datetime | None = None,
    simulated: bool = False,
) -> dict[str, Any]:
    eid = "ce_" + hashlib.sha256(f"{kind}|{network}|{address}|{tx_hash}".encode()).hexdigest()[:10]
    return {
        "id": eid,
        "kind": kind,
        "severity": severity,
        "network": network,
        "address": address,
        "txHash": tx_hash,
        "amount": amount,
        "currency": currency,
        "detail": detail,
        "ledgerIndex": ledger_index,
        "at": iso(at or datetime.now(UTC)),
        "via": via,
        "simulated": simulated,
    }


def _fmt(d: Decimal) -> str:
    return f"{d.normalize():f}"


def classify(network: str, address: str, t: Tx, via: str, lenders: frozenset[str]) -> list[dict[str, Any]]:
    """Credit events for one watched address in one validated transaction. Pure function."""
    if not t.ok:
        return []
    out: list[dict[str, Any]] = []
    common: dict[str, Any] = {"ledger_index": t.ledger_index, "at": t.date}

    if t.type == "Payment" and t.account == address and t.destination != address:
        x = t.delivered_xrp()
        change = t.balance_change(address)
        if (
            x is not None
            and change
            and change[0] > 0
            and x / change[0] >= Decimal(str(C.LARGE_OUTFLOW_RATIO))
        ):
            pct = int(x / change[0] * 100)
            out.append(
                event(
                    "LARGE_OUTFLOW",
                    "warn",
                    network,
                    address,
                    t.hash,
                    f"Sent {_fmt(x)} XRP, {pct}% of the balance before the payment",
                    via,
                    amount=str(x.quantize(Decimal("0.000001"))),
                    currency="XRP",
                    **common,
                )
            )
        if (m := t.memo(C.MEMO_REPAY)) is not None:
            iou = t.delivered_iou()
            out.append(
                event(
                    "MS_REPAY",
                    "info",
                    network,
                    address,
                    t.hash,
                    f"Repaid Moonshift loan {str(m.get('loanId', ''))[:8]}",
                    via,
                    amount=str(iou[2]) if iou else None,
                    currency=iou[0] if iou else None,
                    **common,
                )
            )

    if t.type == "Payment" and t.destination == address:
        if (m := t.memo(C.MEMO_LOAN_DISBURSE)) is not None:
            iou = t.delivered_iou()
            out.append(
                event(
                    "MS_LOAN_DISBURSE",
                    "info",
                    network,
                    address,
                    t.hash,
                    f"Received Moonshift loan {str(m.get('loanId', ''))[:8]}",
                    via,
                    amount=str(iou[2]) if iou else None,
                    currency=iou[0] if iou else None,
                    **common,
                )
            )
        if t.memo(C.MEMO_MARGIN_CALL) is not None:
            out.append(
                event(
                    "MARGIN_CALL",
                    "warn",
                    network,
                    address,
                    t.hash,
                    "Margin call received (MS_MARGIN_CALL memo)",
                    via,
                    **common,
                )
            )

    # Devnet XLS-66: LoanPay carries MS_REPAY; LoanSet (borrower is Counterparty) MS_LOAN_DISBURSE.
    if t.type == "LoanPay" and t.account == address and (m := t.memo(C.MEMO_REPAY)) is not None:
        late = m.get("onTime") is False
        out.append(
            event(
                "MS_REPAY",
                "warn" if late else "info",
                network,
                address,
                t.hash,
                f"{'Late' if late else 'On-time'} XLS-66 LoanPay on Moonshift loan {str(m.get('loanId', ''))[:8]}",
                via,
                amount=str((t.tx.get("Amount") or {}).get("value", "")) or None,
                currency="TDX",
                **common,
            )
        )
    if t.type == "LoanSet" and t.tx.get("Counterparty") == address and t.memo(C.MEMO_LOAN_DISBURSE) is not None:
        out.append(
            event(
                "MS_LOAN_DISBURSE",
                "info",
                network,
                address,
                t.hash,
                f"Opened XLS-66 Moonshift loan of {t.tx.get('PrincipalRequested', '')} TDX",
                via,
                amount=str(t.tx.get("PrincipalRequested", "")) or None,
                currency="TDX",
                **common,
            )
        )

    if t.type == "EscrowFinish" and t.tx.get("Owner") == address and t.account != address:
        if t.memo(C.MEMO_COLLATERAL_RELEASE) is not None:
            return out  # repaid: the broker hands the shares straight back, not a liquidation
        who = "the lending pool" if t.account in lenders else t.account
        out.append(
            event(
                "LIQUIDATION",
                "critical",
                network,
                address,
                t.hash,
                f"Collateral escrow {t.tx.get('OfferSequence')} claimed by {who}",
                via,
                **common,
            )
        )
    return out


async def post_to_api(ev: dict[str, Any]) -> None:
    headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
    url = f"{C.API_URL}/internal/credit-events"
    for attempt in range(C.CREDIT_EVENT_POST_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=5) as http:
                r = await http.post(url, json=ev, headers=headers)
            if r.status_code < 300:
                return
            reason = f"HTTP {r.status_code}"
        except httpx.HTTPError as e:
            reason = type(e).__name__
        await asyncio.sleep(0.5 * 2**attempt)
    log.warning("dropped credit event %s %s for api: %s", ev["id"], ev["kind"], reason)


class Monitor:
    def __init__(self, db: Store, events: EventBus, poster: Poster = post_to_api) -> None:
        self.db, self.bus, self.poster = db, events, poster
        self.seen: set[str] = set()
        self.on_watch_change: Callable[[str], None] | None = None  # set by the WebSocket fallback
        # Any validated tx touching a watched address (network, address, tx, via): live rescoring.
        self.on_tx: Callable[[str, str, Tx, str], None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    # ---- watchlist ----

    def watched(self, network: str | None = None) -> list[dict[str, Any]]:
        sql = (
            "SELECT w.network, w.address, w.since, COUNT(l.loan_id) AS open_loans FROM watch w "
            "LEFT JOIN watch_loans l ON l.network = w.network AND l.address = w.address "
            "AND l.repaid = 0 AND l.missed_reported = 0"
        )
        args: tuple[Any, ...] = ()
        if network:
            sql += " WHERE w.network = ?"
            args = (network,)
        sql += " GROUP BY w.network, w.address ORDER BY w.since, w.address"
        return [
            {
                "network": r["network"],
                "address": r["address"],
                "since": r["since"],
                "openLoans": r["open_loans"],
            }
            for r in self.db.execute(sql, args)
        ]

    def watched_anywhere(self, address: str) -> bool:
        return bool(self.db.execute("SELECT 1 FROM watch WHERE address = ?", (address,)))

    def is_watched(self, network: str, address: str) -> bool:
        return bool(
            self.db.execute("SELECT 1 FROM watch WHERE network = ? AND address = ?", (network, address))
        )

    def add(self, network: str, address: str, loans: list[dict[str, Any]], now: datetime) -> None:
        self.db.execute("INSERT OR IGNORE INTO watch VALUES (?, ?, ?)", (network, address, iso(now)))
        for lo in loans:
            self.track_loan(network, address, str(lo["loanId"]), str(lo["dueAt"]), lo.get("principal"))
        if self.on_watch_change:
            self.on_watch_change(network)

    def remove(self, network: str, address: str) -> None:
        self.db.execute("DELETE FROM watch WHERE network = ? AND address = ?", (network, address))
        self.db.execute("DELETE FROM watch_loans WHERE network = ? AND address = ?", (network, address))
        if self.on_watch_change:
            self.on_watch_change(network)

    def track_loan(
        self, network: str, address: str, loan_id: str, due_at: str, principal: Any = None
    ) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO watch_loans (loan_id, network, address, due_at, principal) "
            "VALUES (?, ?, ?, ?, ?)",
            (loan_id, network, address, due_at, None if principal is None else str(principal)),
        )

    # ---- events ----

    def emit(self, ev: dict[str, Any]) -> bool:
        if ev["id"] in self.seen:
            return False  # Streams retries and WebSocket reconnects can redeliver a tx
        self.seen.add(ev["id"])
        self.bus.publish("credit_event", ev)
        task = asyncio.get_running_loop().create_task(self.poster(ev))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    def handle_tx(
        self, network: str, t: Tx, via: str, addresses: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Classify a tx for every watched address it touches, update loan state, emit events."""
        candidates = addresses or [a for a in (t.account, t.destination, t.tx.get("Owner")) if a]
        lenders = C.lender_addresses()
        emitted: list[dict[str, Any]] = []
        for addr in dict.fromkeys(candidates):
            if not self.is_watched(network, addr):
                continue
            if self.on_tx:
                self.on_tx(network, addr, t, via)
            self._update_loans(network, addr, t, lenders)
            for ev in classify(network, addr, t, via, lenders):
                if self.emit(ev):
                    emitted.append(ev)
        return emitted

    def _update_loans(self, network: str, address: str, t: Tx, lenders: frozenset[str]) -> None:
        if not t.ok:
            return
        if t.type == "EscrowCreate" and t.account == address and t.destination in lenders:
            cancel_after = t.tx.get("CancelAfter")
            if isinstance(cancel_after, int):
                due = datetime.fromtimestamp(
                    cancel_after + C.RIPPLE_EPOCH_OFFSET - C.LOAN_CANCEL_GRACE_SECONDS, UTC
                )
                self.track_loan(network, address, t.hash, iso(due) or "")
        m = t.memo(C.MEMO_REPAY)
        if m and t.account == address:
            self.db.execute("UPDATE watch_loans SET repaid = 1 WHERE loan_id = ?", (str(m.get("loanId")),))
        if t.type == "EscrowFinish" and t.tx.get("Owner") == address and t.account != address:
            # Liquidated: the LIQUIDATION event replaces a later MISSED_PAYMENT for the same loan.
            self.db.execute(
                "UPDATE watch_loans SET missed_reported = 1 WHERE network = ? AND address = ? AND repaid = 0",
                (network, address),
            )

    def check_overdue(self, now: datetime, via: str = "monitor") -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT * FROM watch_loans WHERE repaid = 0 AND missed_reported = 0 ORDER BY due_at, loan_id"
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            due = datetime.fromisoformat(r["due_at"].replace("Z", "+00:00"))
            if due >= now:
                continue
            self.db.execute("UPDATE watch_loans SET missed_reported = 1 WHERE loan_id = ?", (r["loan_id"],))
            ev = event(
                "MISSED_PAYMENT",
                "critical",
                r["network"],
                r["address"],
                r["loan_id"],
                f"Loan {r['loan_id'][:8]} was due {iso(due)} and no MS_REPAY was seen",
                via,
                amount=r["principal"],
                currency="TDX" if r["principal"] else None,
                at=now,
            )
            if self.emit(ev):
                out.append(ev)
        return out

    async def overdue_loop(self) -> None:
        while True:
            try:
                self.check_overdue(datetime.now(UTC))
            except Exception:  # keep the loop alive; one bad row must not stop monitoring
                log.exception("overdue check failed")
            await asyncio.sleep(C.MISSED_PAYMENT_CHECK_SECONDS)


_monitor: Monitor | None = None


def monitor() -> Monitor:
    global _monitor
    if _monitor is None:
        _monitor = Monitor(store(), bus)
    return _monitor

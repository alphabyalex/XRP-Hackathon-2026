"""Turn raw XRPL history into scorecard features. Pure functions: same input, same output."""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from credit import config as C
from credit.history import Tx, ripple_to_datetime

TOP_HASHES = 3
SIX = Decimal("0.000001")


@dataclass
class Feature:
    value: int | float | str | None
    tx_hashes: list[str] = field(default_factory=list)


@dataclass
class Loan:
    loan_id: str  # hash of the borrower's collateral EscrowCreate (packages/xrpl convention)
    due_at: datetime | None
    escrow_sequence: int | None
    repaid_at: datetime | None = None
    repay_hash: str | None = None
    liquidated: bool = False
    payments: list[tuple[str, bool]] = field(default_factory=list)  # XLS-66 LoanPay (hash, onTime)
    late_repay: bool = False  # MS_REPAY said onTime: false


@dataclass
class History:
    address: str
    txs: list[Tx]  # any order
    trustlines: int
    first_tx: Tx | None
    now: datetime
    lenders: frozenset[str] = frozenset()


def xrp_str(d: Decimal) -> str:
    return str(d.quantize(SIX))


def _top(items: list[tuple[Decimal, str]]) -> list[str]:
    return [h for _, h in sorted(items, key=lambda x: (-x[0], x[1]))[:TOP_HASHES]]


def loans(h: History) -> dict[str, Loan]:
    """Moonshift loans visible in this account's history, keyed by loanId.

    packages/xrpl: the borrower locks shares with EscrowCreate (CancelAfter = dueAt + 120 s) to the
    lending pool, then receives a Payment with memo MS_LOAN_DISBURSE {loanId = escrow tx hash}.
    Repayment is a Payment with memo MS_REPAY {loanId}. A default is an EscrowFinish by the lender.
    """
    ok = [t for t in h.txs if t.ok]
    escrows = {t.hash: t for t in ok if t.type == "EscrowCreate" and t.account == h.address}
    loan_ids = {
        str(m.get("loanId")) for t in ok if (m := t.memo(C.MEMO_LOAN_DISBURSE)) and t.destination == h.address
    }
    loan_ids |= {k for k, t in escrows.items() if t.destination in h.lenders}
    out: dict[str, Loan] = {}
    for lid in sorted(loan_ids):
        esc = escrows.get(lid)
        due = None
        if esc is not None and isinstance(esc.tx.get("CancelAfter"), int):
            due = datetime.fromtimestamp(
                esc.tx["CancelAfter"] + C.RIPPLE_EPOCH_OFFSET - C.LOAN_CANCEL_GRACE_SECONDS, tz=UTC
            )
        seq = None
        if esc is not None:
            seq = esc.tx.get("Sequence") or esc.tx.get("TicketSequence")
        out[lid] = Loan(lid, due, seq)
    for t in sorted(ok, key=lambda t: (t.date or h.now, t.hash)):
        m = t.memo(C.MEMO_REPAY)
        if m and t.account == h.address and t.type == "Payment":
            lid = str(m.get("loanId"))
            loan = out.setdefault(lid, Loan(lid, None, None))
            if loan.repaid_at is None:
                loan.repaid_at, loan.repay_hash = t.date, t.hash
    _xls66_loans(h, ok, out)
    by_seq = {lo.escrow_sequence: lo for lo in out.values() if lo.escrow_sequence is not None}
    for t in ok:
        if t.type == "EscrowFinish" and t.tx.get("Owner") == h.address and t.account != h.address:
            # Devnet XLS-66: the broker finishes the collateral escrow both on repayment
            # (MS_COLLATERAL_RELEASE, shares go straight back) and on liquidation
            # (MS_LIQUIDATION). Only the second one is a liquidation.
            if t.memo(C.MEMO_COLLATERAL_RELEASE):
                continue
            liq = t.memo(C.MEMO_LIQUIDATION)
            if liq and str(liq.get("loanId")) in out:
                out[str(liq["loanId"])].liquidated = True
                continue
            offer_seq = t.tx.get("OfferSequence")
            lo = by_seq.get(offer_seq) if isinstance(offer_seq, int) else None
            if lo is not None:
                lo.liquidated = True
            elif t.account in h.lenders:
                out[t.hash] = Loan(t.hash, None, t.tx.get("OfferSequence"), liquidated=True)
    return out


def _xls66_loans(h: History, ok: list[Tx], out: dict[str, Loan]) -> None:
    """Native XLS-66 loans (devnet). packages/xrpl writes:
    LoanSet (broker Account, borrower Counterparty) with memo MS_LOAN_DISBURSE; the Loan ledger
    entry it creates is the loanId. LoanPay by the borrower with memo MS_REPAY {loanId, kind,
    onTime}. A payoff (kind payoff, or the last installment) closes the loan.
    """
    for t in ok:
        if t.type != "LoanSet" or t.tx.get("Counterparty") != h.address:
            continue
        node = next(
            (n["CreatedNode"] for n in t.meta.get("AffectedNodes", []) if n.get("CreatedNode", {}).get("LedgerEntryType") == "Loan"),
            None,
        )
        if node is None:
            continue
        lid = node.get("LedgerIndex")
        nf = node.get("NewFields", {})
        due = nf.get("NextPaymentDueDate")
        out[lid] = Loan(lid, ripple_to_datetime(due) if isinstance(due, int) else None, None)
    for t in sorted(ok, key=lambda t: (t.date or h.now, t.hash)):
        m = t.memo(C.MEMO_REPAY)
        if not m or t.type != "LoanPay" or t.account != h.address:
            continue
        lid = str(m.get("loanId"))
        loan = out.setdefault(lid, Loan(lid, None, None))
        loan.payments.append((t.hash, bool(m.get("onTime", True))))
        closed = not any(
            n.get("ModifiedNode", {}).get("LedgerEntryType") == "Loan"
            and float((n["ModifiedNode"].get("FinalFields") or {}).get("TotalValueOutstanding", 0) or 0) > 0
            for n in t.meta.get("AffectedNodes", [])
        )
        if closed and loan.repaid_at is None:
            loan.repaid_at, loan.repay_hash = t.date, t.hash
            if not m.get("onTime", True):
                loan.late_repay = True


def extract(h: History) -> dict[str, Feature]:
    a = h.address
    ok = [t for t in h.txs if t.ok]
    payments = [t for t in ok if t.type == "Payment"]

    # Account age, from the oldest transaction (the payment that funded the account).
    if h.first_tx is not None and h.first_tx.date is not None:
        age = Feature(max(0, (h.now - h.first_tx.date).days), [h.first_tx.hash])
    else:
        age = Feature(0)

    # A large outflow (over LARGE_OUTFLOW_RATIO of the balance before it) only counts against the
    # borrower: it is left out of the transaction count, counterparties, sent volume and balance
    # stability, so a new counterparty or a crossed band can never cancel its penalty.
    large: set[str] = set()
    for t in ok:
        x = t.delivered_xrp() if t.type == "Payment" else None
        change = t.balance_change(a)
        if t.account == a and t.destination != a and x is not None and change and change[0] > 0:
            if x / change[0] >= Decimal(str(C.LARGE_OUTFLOW_RATIO)):
                large.add(t.hash)

    vol_in: list[tuple[Decimal, str]] = []
    vol_out: list[tuple[Decimal, str]] = []
    counterparties: set[str] = set()
    for t in payments:
        if t.hash in large:
            continue
        x = t.delivered_xrp()
        if t.destination == a and t.account != a:
            counterparties.add(t.account)
            if x is not None:
                vol_in.append((x, t.hash))
        elif t.account == a and t.destination and t.destination != a:
            counterparties.add(t.destination)
            if x is not None:
                vol_out.append((x, t.hash))

    # Balance series (XRP after each tx, oldest first) and the worst single outflow.
    series: list[Decimal] = []
    worst: tuple[Decimal, str] | None = None
    for t in sorted(ok, key=lambda t: (t.ledger_index or 0, t.hash)):
        change = t.balance_change(a)
        if change is None:
            continue
        before, after = change
        if t.hash not in large:
            series.append(after)
        x = t.delivered_xrp() if t.type == "Payment" else None
        if t.account == a and t.destination != a and x is not None and before > 0:
            ratio = x / before
            if worst is None or ratio > worst[0]:
                worst = (ratio, t.hash)

    stability: float | None = None
    if len(series) >= 3:
        floats = [float(v) for v in series]
        mean = statistics.fmean(floats)
        cv = statistics.pstdev(floats) / mean if mean > 0 else 10.0
        stability = round(1 / (1 + cv), 2)

    lo = loans(h)
    on_time: list[str] = []
    late: list[str] = []
    for loan in lo.values():
        if loan.liquidated:
            continue
        if loan.repaid_at is not None and loan.repay_hash is not None:
            if loan.payments:
                (late if loan.late_repay else on_time).append(loan.repay_hash)
            elif loan.due_at is None or loan.repaid_at <= loan.due_at:
                on_time.append(loan.repay_hash)
            else:
                late.append(loan.repay_hash)
        elif loan.due_at is not None and loan.due_at < h.now:
            late.append(loan.loan_id)  # overdue and unpaid: point at the collateral escrow
    margin_calls = [t.hash for t in ok if t.memo(C.MEMO_MARGIN_CALL) and t.destination == a]
    liquidations = [lid for lid, loan in lo.items() if loan.liquidated]
    dividends = [t.hash for t in payments if t.destination == a and t.memo(C.MEMO_DIVIDEND)]
    share_trades = [
        t.hash
        for t in ok
        if t.type == "OfferCreate" and t.account == a and _codes(t.tx) & C.MOONSHIFT_TOKEN_CODES
    ]

    return {
        "accountAgeDays": age,
        "txCount": Feature(len(h.txs) - len(large)),
        "paymentVolumeInXrp": Feature(xrp_str(sum((x for x, _ in vol_in), Decimal(0))), _top(vol_in)),
        "paymentVolumeOutXrp": Feature(xrp_str(sum((x for x, _ in vol_out), Decimal(0))), _top(vol_out)),
        "distinctCounterparties": Feature(len(counterparties)),
        "trustlines": Feature(h.trustlines),
        "balanceStability": Feature(stability),
        "largestOutflowRatio": Feature(
            round(float(worst[0]), 2) if worst else None, [worst[1]] if worst else []
        ),
        "largeOutflows": Feature(len(large), sorted(large)[:TOP_HASHES]),
        "msRepaysOnTime": Feature(len(on_time), sorted(on_time)),
        "msRepaysLate": Feature(len(late), sorted(late)),
        "msMarginCalls": Feature(len(margin_calls), sorted(margin_calls)),
        "msLiquidations": Feature(len(liquidations), sorted(liquidations)),
        "msDividendsReceived": Feature(len(dividends), sorted(dividends)[:TOP_HASHES]),
        "msShareTrades": Feature(len(share_trades), sorted(share_trades)[:TOP_HASHES]),
    }


def _codes(tx: dict[str, Any]) -> set[str]:
    """Issued currency codes on either side of an offer (XRP amounts are strings and have none)."""
    return {amt["currency"] for amt in (tx.get("TakerGets"), tx.get("TakerPays")) if isinstance(amt, dict)}


def open_loans(h: History) -> list[dict[str, Any]]:
    """Unrepaid, unliquidated loans with a known due time (used by live monitoring)."""
    return [
        {"loanId": lo.loan_id, "dueAt": lo.due_at.isoformat().replace("+00:00", "Z")}
        for lo in loans(h).values()
        if lo.repaid_at is None and not lo.liquidated and lo.due_at is not None
    ]

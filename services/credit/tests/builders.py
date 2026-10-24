"""Synthetic account histories for scoring tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from credit import features as F
from credit.history import normalize
from tests.fakes import account_root, entry, memo, ripple_time

NOW = datetime(2026, 10, 24, 17, 0, tzinfo=UTC)
BORROWER = "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb"
POOL = "rHJboRpVV1JByZ4C3ta2cw4pn6oUB1Q7Dg"  # LENDING_POOL in contracts/accounts.testnet.json
PEERS = [f"rPEER{i:02d}xxxxxxxxxxxxxxxxxxxxxxx" for i in range(40)]
DROPS = 1_000_000
TDX = {"currency": "TDX", "issuer": "rppRGPmSSzP5pTo5XxFkKuTkKyDTeTyx5K", "value": "50"}


def iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def h(n: int, prefix: str = "A") -> str:
    return f"{prefix}{n:063X}"


def old_active_entries(address: str = BORROWER) -> list[dict[str, Any]]:
    """Four years, 300 payments with 30 counterparties, balance hovering around 1,000 XRP."""
    out = []
    bal = 1000 * DROPS
    start = NOW - timedelta(days=4 * 365)
    for i in range(300):
        at = iso(start + timedelta(days=i * 4))
        peer = PEERS[i % 30]
        if i % 2 == 0:
            amt = 40 * DROPS
            out.append(
                entry(
                    h(i),
                    "Payment",
                    peer,
                    at,
                    1000 + i,
                    destination=address,
                    amount=str(amt),
                    nodes=[account_root(address, bal, bal + amt)],
                )
            )
            bal += amt
        else:
            amt = 35 * DROPS
            out.append(
                entry(
                    h(i),
                    "Payment",
                    address,
                    at,
                    1000 + i,
                    destination=peer,
                    amount=str(amt),
                    nodes=[account_root(address, bal, bal - amt - 12)],
                )
            )
            bal -= amt + 12
    return out


def new_empty_entries(address: str = BORROWER) -> list[dict[str, Any]]:
    """Funded five days ago with 20 XRP, nothing since."""
    return [
        entry(
            h(0, "B"),
            "Payment",
            PEERS[0],
            iso(NOW - timedelta(days=5)),
            5000,
            destination=address,
            amount=str(20 * DROPS),
            nodes=[
                {
                    "CreatedNode": {
                        "LedgerEntryType": "AccountRoot",
                        "NewFields": {"Account": address, "Balance": str(20 * DROPS)},
                    }
                }
            ],
        )
    ]


def loan_entries(
    n: int,
    *,
    address: str = BORROWER,
    due: datetime,
    repay_at: datetime | None = None,
    liquidate_at: datetime | None = None,
    margin_call_at: datetime | None = None,
    seq: int = 777,
) -> list[dict[str, Any]]:
    """One Moonshift loan exactly as packages/xrpl writes it."""
    lid = h(n, "E")
    opened = due - timedelta(minutes=10)
    cancel_after = ripple_time(iso(due)) + 120
    out = [
        entry(
            lid,
            "EscrowCreate",
            address,
            iso(opened),
            9000 + n,
            destination=POOL,
            amount={"currency": "GPA", "issuer": "rw9GnGPc5JQLF2uS4aJLeU9TAL5evz8LyT", "value": "100"},
            CancelAfter=cancel_after,
            Sequence=seq,
        ),
        entry(
            h(n, "D"),
            "Payment",
            POOL,
            iso(opened + timedelta(seconds=5)),
            9001 + n,
            destination=address,
            amount=TDX,
            memos=memo({"type": "MS_LOAN_DISBURSE", "loanId": lid}),
        ),
    ]
    if repay_at:
        out.append(
            entry(
                h(n, "F"),
                "Payment",
                address,
                iso(repay_at),
                9002 + n,
                destination=POOL,
                amount=TDX,
                memos=memo({"type": "MS_REPAY", "loanId": lid}),
            )
        )
    if margin_call_at:
        out.append(
            entry(
                h(n, "C"),
                "Payment",
                POOL,
                iso(margin_call_at),
                9003 + n,
                destination=address,
                amount="1",
                memos=memo({"type": "MS_MARGIN_CALL", "loanId": lid}),
            )
        )
    if liquidate_at:
        out.append(
            entry(
                h(n, "L"), "EscrowFinish", POOL, iso(liquidate_at), 9004 + n, Owner=address, OfferSequence=seq
            )
        )
    return out


def history(entries: list[dict[str, Any]], *, address: str = BORROWER, trustlines: int = 2) -> F.History:
    txs = [normalize(e) for e in entries]
    first = min(txs, key=lambda t: t.date or NOW) if txs else None
    return F.History(address, txs, trustlines, first, NOW, frozenset({POOL}))

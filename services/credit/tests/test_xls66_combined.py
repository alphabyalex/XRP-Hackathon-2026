"""Devnet XLS-66 loan history, the combined profile, demo links and /stats."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from credit import combine, stats
from credit import features as F
from credit.history import normalize
from credit.link import linker
from tests.builders import BORROWER, NOW, h, iso, old_active_entries
from tests.fakes import entry, memo, ripple_time

BROKER = "rsWQVjDESTe9JsS3DXL92icYXtpBF4Xktw"  # devnet LENDING_POOL in contracts/accounts.devnet.json


def loan_set(n: int, loan_id: str, at: str, due: str) -> dict:
    return entry(
        h(n, "C"),
        "LoanSet",
        BROKER,
        at,
        9000 + n,
        Counterparty=BORROWER,
        memos=memo({"type": "MS_LOAN_DISBURSE", "nonce": f"N{n}"}),
        nodes=[{"CreatedNode": {"LedgerEntryType": "Loan", "LedgerIndex": loan_id, "NewFields": {"NextPaymentDueDate": ripple_time(due)}}}],
    )


def loan_pay(n: int, loan_id: str, at: str, on_time: bool, closes: bool) -> dict:
    return entry(
        h(n, "D"),
        "LoanPay",
        BORROWER,
        at,
        9100 + n,
        memos=memo({"type": "MS_REPAY", "loanId": loan_id, "kind": "payoff", "onTime": on_time}),
        nodes=[{"ModifiedNode": {"LedgerEntryType": "Loan", "FinalFields": {"TotalValueOutstanding": "0" if closes else "10"}}}],
    )


def escrow_finish(n: int, memo_type: str, loan_id: str, at: str) -> dict:
    return entry(h(n, "E"), "EscrowFinish", BROKER, at, 9200 + n, Owner=BORROWER, OfferSequence=100 + n, memos=memo({"type": memo_type, "loanId": loan_id}))


def hist(entries: list[dict]) -> F.History:
    return F.History(BORROWER, [normalize(e) for e in entries], 2, None, NOW, frozenset({BROKER}))


def test_xls66_repay_and_release_are_not_liquidations() -> None:
    t0 = NOW - timedelta(days=2)
    lid = "L" * 64
    entries = [
        loan_set(1, lid, iso(t0), iso(t0 + timedelta(days=1))),
        loan_pay(1, lid, iso(t0 + timedelta(hours=3)), on_time=True, closes=True),
        escrow_finish(1, "MS_COLLATERAL_RELEASE", lid, iso(t0 + timedelta(hours=3))),
    ]
    f = F.extract(hist(entries))
    assert f["msRepaysOnTime"].value == 1
    assert f["msLiquidations"].value == 0
    assert f["msRepaysLate"].value == 0


def test_xls66_liquidation_and_late_repay_count() -> None:
    t0 = NOW - timedelta(days=3)
    a, b = "A" * 64, "B" * 64
    entries = [
        loan_set(1, a, iso(t0), iso(t0 + timedelta(hours=1))),
        entry(h(7, "F"), "Payment", BROKER, iso(t0 + timedelta(minutes=30)), 9300, destination=BORROWER, amount="1", memos=memo({"type": "MS_MARGIN_CALL", "loanId": a})),
        escrow_finish(2, "MS_LIQUIDATION", a, iso(t0 + timedelta(minutes=40))),
        loan_set(2, b, iso(t0 + timedelta(days=1)), iso(t0 + timedelta(days=1, hours=1))),
        loan_pay(2, b, iso(t0 + timedelta(days=1, hours=2)), on_time=False, closes=True),
    ]
    f = F.extract(hist(entries))
    assert f["msLiquidations"].value == 1
    assert f["msMarginCalls"].value == 1
    assert f["msRepaysLate"].value == 1
    assert f["msRepaysOnTime"].value == 0


def test_merge_takes_moonshift_features_from_borrower_and_history_from_link() -> None:
    borrower = F.extract(hist([]))
    linked = F.extract(F.History(BORROWER, [normalize(e) for e in old_active_entries()], 3, None, NOW))
    merged = combine.merge(borrower, linked)
    assert merged["txCount"].value == linked["txCount"].value
    assert merged["msRepaysOnTime"].value == borrower["msRepaysOnTime"].value
    assert set(merged) == set(linked)


def test_demo_link_is_labeled_unverified() -> None:
    mainnet = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
    who = "rDemoBorrowerxxxxxxxxxxxxxxxxxxxx"  # no verified link (a verified one would win)
    out = linker().demo_link(who, mainnet, NOW)
    assert out["status"] == "unverified, demo" and out["verified"] is False
    link = linker().link_for(who)
    assert link and link["mainnetAddress"] == mainnet
    assert link["ownership"]["status"] == "unverified, demo"


def test_stats_counts_calls_credits_and_hits() -> None:
    before = stats.snapshot()["quicknode"]["calls"]
    stats.record_call("mainnet", "quicknode", "account_tx", 120.0, True)
    stats.record_call("mainnet", "quicknode", "account_info", 80.0, True)
    stats.record_hit("mainnet", "quicknode")
    snap = stats.snapshot()
    assert snap["quicknode"]["calls"] == before + 2
    assert snap["quicknode"]["creditsUsed"] == (before + 2) * stats.CREDITS_PER_CALL
    assert snap["quicknode"]["byMethod"]["account_tx"] >= 1
    assert snap["quicknode"]["cacheHitRate"] > 0


def test_stats_route_has_no_urls() -> None:
    from credit.main import app

    body = TestClient(app).get("/stats").json()
    assert "quicknode" in body and "quicknodeConfigured" in body
    assert "http" not in str(body).lower().replace("httpx", "")


def test_monitor_classifies_xls66_repay_and_ignores_release() -> None:
    from credit.monitor import classify

    lid = "M" * 64
    pay = normalize(loan_pay(5, lid, iso(NOW), on_time=True, closes=True))
    evs = classify("devnet", BORROWER, pay, "websocket (public devnet)", frozenset({BROKER}))
    assert [e["kind"] for e in evs] == ["MS_REPAY"] and evs[0]["via"] == "websocket (public devnet)"
    release = normalize(escrow_finish(5, "MS_COLLATERAL_RELEASE", lid, iso(NOW)))
    assert classify("devnet", BORROWER, release, "websocket", frozenset({BROKER})) == []
    seize = normalize(escrow_finish(6, "MS_LIQUIDATION", lid, iso(NOW)))
    assert [e["kind"] for e in classify("devnet", BORROWER, seize, "websocket", frozenset({BROKER}))] == ["LIQUIDATION"]

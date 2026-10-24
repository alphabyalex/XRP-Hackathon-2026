import random
from datetime import timedelta

from credit import features as F
from credit import scoring
from tests.builders import NOW, history, loan_entries, new_empty_entries, old_active_entries


def score_of(entries, **kw):
    return scoring.score(F.extract(history(entries, **kw)))


def test_old_active_account_outscores_new_empty_one():
    old = score_of(old_active_entries())
    new = score_of(new_empty_entries(), trustlines=0)
    assert old.score > new.score
    assert old.grade in {"A", "B"}
    assert old.confidence == "high"
    assert new.confidence == "low"


def test_liquidation_lowers_the_score():
    base = old_active_entries()
    due = NOW - timedelta(days=3)
    clean = score_of(base + loan_entries(1, due=due, repay_at=due - timedelta(minutes=2)))
    liquidated = score_of(base + loan_entries(1, due=due, liquidate_at=due + timedelta(minutes=5)))
    assert liquidated.score < clean.score
    assert liquidated.features["msLiquidations"]["value"] == 1
    assert liquidated.features["msLiquidations"]["txHashes"]  # points at the loan
    assert "MS_LIQUIDATED" in liquidated.reasons


def test_same_input_always_gives_the_same_score():
    entries = old_active_entries() + loan_entries(
        1, due=NOW - timedelta(days=1), repay_at=NOW - timedelta(days=2)
    )
    first = score_of(entries)
    for seed in range(5):
        shuffled = entries[:]
        random.Random(seed).shuffle(shuffled)
        again = score_of(shuffled)
        assert (again.score, again.features, again.reasons) == (first.score, first.features, first.reasons)


def test_thin_file_gets_low_confidence_and_a_cap():
    # Young account but with lots of activity: raw points could be high, the cap holds it down.
    entries = [e for e in old_active_entries() if e["tx"]["date"] > 0][-60:]
    hist = history(entries)
    hist.first_tx = hist.txs[-1]
    hist.now = hist.txs[-1].date + timedelta(days=30)  # 30 days old
    s = scoring.score(F.extract(hist))
    assert s.confidence == "low"
    assert s.score <= 60
    assert "THIN_FILE" in s.reasons


def test_on_time_and_late_repayments_from_cancel_after():
    due = NOW - timedelta(days=10)
    on_time = F.extract(history(loan_entries(1, due=due, repay_at=due - timedelta(minutes=1))))
    late = F.extract(history(loan_entries(1, due=due, repay_at=due + timedelta(hours=2))))
    assert (on_time["msRepaysOnTime"].value, on_time["msRepaysLate"].value) == (1, 0)
    assert (late["msRepaysOnTime"].value, late["msRepaysLate"].value) == (0, 1)


def test_overdue_unpaid_loan_counts_as_late():
    f = F.extract(history(loan_entries(1, due=NOW - timedelta(hours=1))))
    assert f["msRepaysLate"].value == 1


def test_open_loan_not_yet_due_is_not_late():
    hist = history(loan_entries(1, due=NOW + timedelta(minutes=5)))
    assert F.extract(hist)["msRepaysLate"].value == 0
    assert F.open_loans(hist)[0]["dueAt"].endswith("Z")


def test_margin_call_memo_is_counted():
    due = NOW - timedelta(days=1)
    f = F.extract(history(loan_entries(1, due=due, repay_at=due, margin_call_at=due - timedelta(minutes=3))))
    assert f["msMarginCalls"].value == 1


def test_every_feature_carries_points_and_reason():
    s = score_of(old_active_entries())
    for name, feat in s.features.items():
        assert set(feat) == {"value", "points", "reason", "txHashes"}, name
    assert s.score == max(0, min(100, s.raw_points))


def test_volume_and_outflow_features():
    f = F.extract(history(old_active_entries()))
    assert f["paymentVolumeInXrp"].value == "6000.000000"  # 150 x 40 XRP
    assert f["paymentVolumeOutXrp"].value == "5250.000000"  # 150 x 35 XRP
    assert f["distinctCounterparties"].value == 30
    assert 0 < f["largestOutflowRatio"].value < 0.25
    assert len(f["paymentVolumeInXrp"].tx_hashes) == 3
    assert f["balanceStability"].value > 0.6


def test_band_selection_edges():
    assert scoring.band("accountAgeDays", 365) == (6, "ACCOUNT_AGE_1Y_PLUS")
    assert scoring.band("accountAgeDays", 364) == (0, "ACCOUNT_AGE_90D_PLUS")
    assert scoring.band("largestOutflowRatio", None) == (0, "NO_OUTFLOWS")
    assert scoring.grade_for(80) == "A"
    assert scoring.grade_for(34) == "E"


def test_legacy_gb_memos_count_as_moonshift_memos():
    """Loans written before the Groundbreak to Moonshift rename use GB_ memo types (seen on testnet)."""
    entries = loan_entries(1, due=NOW - timedelta(days=1), repay_at=NOW - timedelta(days=2))
    for e in entries:
        for m in e["tx"].get("Memos", []):
            raw = bytes.fromhex(m["Memo"]["MemoData"]).decode().replace('"MS_', '"GB_')
            m["Memo"]["MemoData"] = raw.encode().hex().upper()
    f = F.extract(history(entries))
    assert (f["msRepaysOnTime"].value, f["msRepaysLate"].value) == (1, 0)


def test_moonshift_dividends_and_share_trades_feed_credit():
    from tests.fakes import entry, memo

    base = old_active_entries()
    gpa = {"currency": "GPA", "issuer": "rw9GnGPc5JQLF2uS4aJLeU9TAL5evz8LyT", "value": "10"}
    extra = [
        entry(
            f"{i:064X}".replace("0", "9", 1),
            "Payment",
            "rUzFXKGtp6rtVbb7qon7Vw7fY5ZjRsbTrt",
            "2026-10-01T00:00:00Z",
            8000 + i,
            destination=base[0]["tx"]["Destination"],
            amount={"currency": "TDX", "issuer": "rppRGPmSSzP5pTo5XxFkKuTkKyDTeTyx5K", "value": "1.5"},
            memos=memo({"type": "GB_DIVIDEND", "amount": "1.500000"}),
        )
        for i in range(5)
    ] + [
        entry(
            "7" * 64,
            "OfferCreate",
            base[0]["tx"]["Destination"],
            "2026-10-02T00:00:00Z",
            8100,
            TakerPays=gpa,
            TakerGets="1000000",
        ),
        entry(
            "6" * 64,
            "OfferCreate",
            base[0]["tx"]["Destination"],
            "2026-10-02T00:00:00Z",
            8101,
            TakerPays={"currency": "USD", "issuer": "rIssuer", "value": "1"},
            TakerGets="1",
        ),
    ]
    with_activity = score_of(base + extra)
    f = with_activity.features
    assert (f["msDividendsReceived"]["value"], f["msShareTrades"]["value"]) == (5, 1)
    assert with_activity.raw_points == score_of(base).raw_points + 4 + 1

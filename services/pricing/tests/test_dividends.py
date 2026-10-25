"""Dividend split when new accounts' starting shares grow the supply past the original count."""

from decimal import Decimal

from app.models import dividends


def test_supply_above_original_count_divides_by_outstanding():
    r = dividends.propose(
        gross_revenue=Decimal("3.102012"),
        holders=[("rUser1", Decimal("500")), ("rUser2", Decimal("500")), ("rUser3", Decimal("500"))],
        shares_total=1000,
        excluded=frozenset(),
        hosting_fee_bps=1500,
        reserve_bps=500,
    )
    paid = sum(p.amount for p in r.payouts)
    assert paid <= r.distributable
    assert r.per_share == (r.distributable / Decimal(1500)).quantize(Decimal("0.000001"), rounding="ROUND_FLOOR")
    assert len(r.payouts) == 3

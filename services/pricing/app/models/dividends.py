"""Dividend proposal (B3.4).

Invariants (see tests/test_dividends.py):
  sum(payouts) + dust == distributable
  every payout >= 0
  no payout to an excluded (treasury / issuer / system) account
  same input -> same output
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import floor6, has_at_most_6dp, round6

BPS = Decimal(10_000)


@dataclass(frozen=True)
class Payout:
    account: str
    shares: Decimal
    amount: Decimal


@dataclass(frozen=True)
class DividendResult:
    gross_revenue: Decimal
    hosting_fee: Decimal
    reserve: Decimal
    distributable: Decimal
    payouts: list[Payout]
    dust: Decimal  # treasury_retained + rounding_dust; stays in the treasury
    treasury_retained: Decimal  # portion belonging to shares not held by outside holders
    rounding_dust: Decimal
    per_share: Decimal
    denominator_shares: Decimal
    held_shares: Decimal
    excluded_accounts: list[str]


def propose(
    *,
    gross_revenue: Decimal,
    holders: list[tuple[str, Decimal]],
    shares_total: int,
    excluded: frozenset[str],
    hosting_fee_bps: int,
    reserve_bps: int,
    denominator: str = "outstanding",
) -> DividendResult:
    """Split one period's gross revenue into fee, reserve and per-holder payouts.

    denominator="outstanding": each share earns distributable / shares_total, so the portion
    belonging to unsold treasury shares stays in the treasury.
    denominator="held": distributable is split only among outside holders.
    """
    if gross_revenue < 0 or not has_at_most_6dp(gross_revenue):
        raise ValueError("gross_revenue must be >= 0 with at most 6 decimals")
    if denominator not in {"outstanding", "held"}:
        raise ValueError("denominator must be 'outstanding' or 'held'")

    seen: set[str] = set()
    eligible: list[tuple[str, Decimal]] = []
    excluded_hit: list[str] = []
    for account, shares in holders:
        if account in seen:
            raise ValueError(f"duplicate holder: {account}")
        seen.add(account)
        if shares < 0:
            raise ValueError(f"negative shares for {account}")
        if account in excluded or account.upper() in excluded:
            excluded_hit.append(account)
            continue
        if shares > 0:
            eligible.append((account, shares))

    held = sum((s for _, s in eligible), Decimal(0))
    if held > shares_total:
        raise ValueError(f"holders hold {held} shares but only {shares_total} exist")

    fee = round6(gross_revenue * hosting_fee_bps / BPS)
    reserve = round6((gross_revenue - fee) * reserve_bps / BPS)
    distributable = gross_revenue - fee - reserve

    denom = Decimal(shares_total) if denominator == "outstanding" else held
    payouts: list[Payout] = []
    if denom > 0:
        for account, shares in sorted(eligible):
            amount = floor6(distributable * shares / denom)
            if amount > 0:
                payouts.append(Payout(account, shares, amount))

    paid = sum((p.amount for p in payouts), Decimal(0))
    dust = distributable - paid
    exact_to_holders = distributable * held / denom if denom > 0 else Decimal(0)
    treasury_retained = floor6(distributable - exact_to_holders)
    rounding_dust = dust - treasury_retained

    return DividendResult(
        gross_revenue=gross_revenue,
        hosting_fee=fee,
        reserve=reserve,
        distributable=distributable,
        payouts=payouts,
        dust=dust,
        treasury_retained=treasury_retained,
        rounding_dust=rounding_dust,
        per_share=floor6(distributable / denom) if denom > 0 else Decimal(0),
        denominator_shares=denom,
        held_shares=held,
        excluded_accounts=sorted(excluded_hit),
    )

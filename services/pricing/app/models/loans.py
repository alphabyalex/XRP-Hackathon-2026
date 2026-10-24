"""Loan quote against escrowed shares (B3.5)."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import ceil6, floor6

BPS = Decimal(10_000)
MINUTES_PER_YEAR = Decimal(365 * 24 * 60)


@dataclass(frozen=True)
class LoanQuote:
    collateral_value: Decimal
    max_principal: Decimal
    principal: Decimal
    ltv_pct: Decimal
    liquidation_value: Decimal  # collateral value at which the loan hits liquidation LTV
    apr_bps: int
    term_minutes: int
    interest: Decimal
    amount_due: Decimal


def quote(
    *,
    nav_per_share: Decimal,
    shares: Decimal,
    max_ltv_bps: int,
    liquidation_ltv_bps: int,
    apr_bps: int,
    term_minutes: int,
    principal: Decimal | None = None,
) -> LoanQuote:
    if shares <= 0:
        raise ValueError("shares must be positive")
    if term_minutes <= 0:
        raise ValueError("term_minutes must be positive")

    collateral = floor6(nav_per_share * shares)
    max_principal = floor6(collateral * max_ltv_bps / BPS)
    p = max_principal if principal is None else principal
    if p < 0:
        raise ValueError("principal must be non-negative")
    if p > max_principal:
        raise ValueError(f"principal {p} exceeds max {max_principal}")

    # Rounding favors the lender: liquidation triggers slightly earlier, interest rounds up.
    liquidation_value = ceil6(p * BPS / liquidation_ltv_bps)
    interest = ceil6(p * apr_bps / BPS * term_minutes / MINUTES_PER_YEAR)
    return LoanQuote(
        collateral_value=collateral,
        max_principal=max_principal,
        principal=p,
        ltv_pct=(p / collateral * 100) if collateral > 0 else Decimal(0),
        liquidation_value=liquidation_value,
        apr_bps=apr_bps,
        term_minutes=term_minutes,
        interest=interest,
        amount_due=p + interest,
    )

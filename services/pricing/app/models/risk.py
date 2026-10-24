"""Deterministic risk flags. The agent may add flags only from ALLOWED_FLAGS."""

from __future__ import annotations

from decimal import Decimal

ALLOWED_FLAGS = frozenset(
    {
        "REVENUE_SPIKE",
        "LOW_UTILIZATION",
        "CONCENTRATED_HOLDER",
        "HIGH_LTV",
        "ZERO_REVENUE",
        "NO_HOLDERS",
        "SYSTEM_ACCOUNT_EXCLUDED",
        "FLOOR_PRICE_BINDING",
        "NEGATIVE_NET_REVENUE",
    }
)


def dividend_flags(
    *,
    gross_revenue: Decimal,
    holder_shares: list[Decimal],
    shares_total: int,
    excluded_count: int,
    concentrated_pct: Decimal,
    utilization_pct: Decimal | None = None,
    low_util_pct: Decimal | None = None,
    trailing_avg_gross: Decimal | None = None,
    spike_multiple: Decimal | None = None,
) -> list[str]:
    flags: list[str] = []
    if gross_revenue == 0:
        flags.append("ZERO_REVENUE")
    if not holder_shares:
        flags.append("NO_HOLDERS")
    if any(s * 100 / shares_total > concentrated_pct for s in holder_shares):
        flags.append("CONCENTRATED_HOLDER")
    if excluded_count:
        flags.append("SYSTEM_ACCOUNT_EXCLUDED")
    if utilization_pct is not None and low_util_pct is not None and utilization_pct < low_util_pct:
        flags.append("LOW_UTILIZATION")
    if (
        trailing_avg_gross is not None
        and spike_multiple is not None
        and trailing_avg_gross > 0
        and gross_revenue > trailing_avg_gross * spike_multiple
    ):
        flags.append("REVENUE_SPIKE")
    return flags


def loan_flags(*, ltv_pct: Decimal, high_ltv_pct: Decimal) -> list[str]:
    return ["HIGH_LTV"] if ltv_pct >= high_ltv_pct else []

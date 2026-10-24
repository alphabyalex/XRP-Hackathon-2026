"""NAV per share (B3.3): treasury cash plus discounted future net revenue, per share."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import clamp, round6

BPS = Decimal(10_000)


def monthly_rate(annual_rate: Decimal) -> Decimal:
    """Effective monthly rate equivalent to an effective annual rate."""
    return (1 + annual_rate) ** (Decimal(1) / Decimal(12)) - 1


def annuity_factor(rate_per_period: Decimal, periods: int) -> Decimal:
    """PV of 1 paid at the end of each period for `periods` periods."""
    if periods <= 0:
        return Decimal(0)
    if rate_per_period == 0:
        return Decimal(periods)
    return (1 - (1 + rate_per_period) ** -periods) / rate_per_period


def blended_revenue_per_hour(
    contract_hourly: Decimal, inference_hourly: Decimal, booked_fraction: Decimal
) -> Decimal:
    """Revenue per utilized hour, mixing booked-slot hours and inference hours."""
    return booked_fraction * contract_hourly + (1 - booked_fraction) * inference_hourly


@dataclass(frozen=True)
class NavResult:
    nav_per_share: Decimal
    pv_future_net: Decimal
    utilization_used_pct: Decimal
    net_revenue_per_hour: Decimal
    net_revenue_per_month: Decimal
    monthly_discount_rate: Decimal
    annuity_factor: Decimal


def nav(
    *,
    treasury_cash: Decimal,
    utilization_pct: Decimal,
    blended_revenue_per_hour: Decimal,
    hosting_fee_bps: int,
    power_cost_per_hour: Decimal,
    life_months: int,
    discount_rate_annual: Decimal,
    hours_per_month: Decimal,
    shares_total: int,
    util_min: Decimal,
    util_max: Decimal,
) -> NavResult:
    if shares_total <= 0:
        raise ValueError("shares_total must be positive")
    util = clamp(utilization_pct, util_min, util_max)
    fee = Decimal(hosting_fee_bps) / BPS
    net_hour = (util / 100) * blended_revenue_per_hour * (1 - fee) - power_cost_per_hour
    net_month = net_hour * hours_per_month
    r = monthly_rate(discount_rate_annual)
    af = annuity_factor(r, life_months)
    pv = net_month * af
    # A share cannot be worth less than nothing; negative PV just means the GPU is uneconomic.
    total = max(Decimal(0), treasury_cash + pv)
    return NavResult(
        nav_per_share=round6(total / shares_total),
        pv_future_net=round6(pv),
        utilization_used_pct=util,
        net_revenue_per_hour=round6(net_hour),
        net_revenue_per_month=round6(net_month),
        monthly_discount_rate=r,
        annuity_factor=af,
    )


def implied_yield_pct(
    trailing_dividends_per_share: Decimal, period_days: Decimal, share_price: Decimal
) -> Decimal:
    """Trailing dividends annualized, divided by share price, as a percent."""
    if share_price <= 0 or period_days <= 0:
        return Decimal(0)
    annualized = trailing_dividends_per_share * Decimal(365) / period_days
    return annualized / share_price * 100

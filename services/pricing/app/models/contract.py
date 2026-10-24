"""GPU slot contract price (B3.2)."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import clamp, round6

MINUTES_PER_HOUR = Decimal(60)


def scarcity_premium(booked_share_24h: Decimal, max_premium: Decimal) -> Decimal:
    """Linear in the booked fraction (0..1) of the next 24h: 0% empty, max_premium fully booked."""
    return max_premium * clamp(booked_share_24h, Decimal(0), Decimal(1))


def lead_time_discount(
    lead_hours: Decimal, start_hours: Decimal, full_hours: Decimal, max_discount: Decimal
) -> Decimal:
    """No discount within `start_hours`; rises linearly to max_discount at `full_hours`."""
    if lead_hours <= start_hours:
        return Decimal(0)
    ramp = clamp((lead_hours - start_hours) / (full_hours - start_hours), Decimal(0), Decimal(1))
    return max_discount * ramp


@dataclass(frozen=True)
class ContractPrice:
    price_per_slot: Decimal
    base: Decimal
    scarcity_premium_pct: Decimal
    lead_time_discount_pct: Decimal
    market_price: Decimal
    marginal_cost: Decimal
    expected_inference_revenue: Decimal
    idle_sell_probability: Decimal
    forgone_inference: Decimal
    floor: Decimal
    floor_binding: bool


def contract_price(
    *,
    reference_hourly: Decimal,
    slot_minutes: int,
    booked_share_24h: Decimal,
    lead_hours: Decimal,
    utilization_pct: Decimal,
    inference_revenue_per_hour: Decimal,
    marginal_cost_per_hour: Decimal,
    scarcity_max: Decimal,
    lead_discount_max: Decimal,
    lead_discount_start_hours: Decimal,
    lead_discount_full_hours: Decimal,
) -> ContractPrice:
    if slot_minutes <= 0:
        raise ValueError("slot_minutes must be positive")
    if lead_hours < 0:
        raise ValueError("slot_start is in the past")

    slot_hours = Decimal(slot_minutes) / MINUTES_PER_HOUR
    base = reference_hourly * slot_hours
    premium = scarcity_premium(booked_share_24h, scarcity_max)
    discount = lead_time_discount(
        lead_hours, lead_discount_start_hours, lead_discount_full_hours, lead_discount_max
    )
    market = base * (1 + premium) * (1 - discount)

    # Floor: never sell a slot for less than serving inference in it would have earned.
    marginal = marginal_cost_per_hour * slot_hours
    expected_inference = inference_revenue_per_hour * slot_hours
    idle_sell_p = clamp(utilization_pct / 100, Decimal(0), Decimal(1))
    forgone = expected_inference * idle_sell_p
    floor = marginal + forgone

    price = max(market, floor)
    return ContractPrice(
        price_per_slot=round6(price),
        base=round6(base),
        scarcity_premium_pct=premium * 100,
        lead_time_discount_pct=discount * 100,
        market_price=round6(market),
        marginal_cost=round6(marginal),
        expected_inference_revenue=round6(expected_inference),
        idle_sell_probability=idle_sell_p,
        forgone_inference=round6(forgone),
        floor=round6(floor),
        floor_binding=floor > market,
    )

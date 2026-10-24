"""Inference rate card: price per 1M tokens for idle-time inference (B3.1)."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.money import clamp, round6

MTOK = Decimal(1_000_000)
SECONDS_PER_HOUR = Decimal(3600)


def utilization_surcharge(
    utilization_pct: Decimal, start: Decimal, full: Decimal, max_surcharge: Decimal
) -> Decimal:
    """0 below `start`%, rising linearly to `max_surcharge` at `full`%, flat above."""
    if utilization_pct <= start:
        return Decimal(0)
    ramp = clamp((utilization_pct - start) / (full - start), Decimal(0), Decimal(1))
    return max_surcharge * ramp


@dataclass(frozen=True)
class RateCard:
    floor_per_mtok: Decimal  # cost to produce 1M output tokens at full load
    surcharge: Decimal  # fraction, e.g. 0.15 = +15%
    output_per_mtok: Decimal
    input_per_mtok: Decimal
    base_fee: Decimal


def rate_card(
    *,
    hourly_cost: Decimal,
    tokens_per_sec: Decimal,
    utilization_pct: Decimal,
    margin: Decimal,
    input_ratio: Decimal,
    surcharge_start: Decimal,
    surcharge_full: Decimal,
    surcharge_max: Decimal,
    base_fee: Decimal,
) -> RateCard:
    if tokens_per_sec <= 0:
        raise ValueError("tokens_per_sec must be positive")
    if hourly_cost < 0:
        raise ValueError("hourly_cost must be non-negative")

    floor = hourly_cost / (tokens_per_sec * SECONDS_PER_HOUR) * MTOK
    surcharge = utilization_surcharge(utilization_pct, surcharge_start, surcharge_full, surcharge_max)
    output = round6(floor * (1 + margin) * (1 + surcharge))
    return RateCard(
        floor_per_mtok=round6(floor),
        surcharge=surcharge,
        output_per_mtok=output,
        input_per_mtok=round6(output * input_ratio),
        base_fee=round6(base_fee),
    )


def full_load_revenue_per_hour(output_per_mtok: Decimal, tokens_per_sec: Decimal) -> Decimal:
    """Revenue for one hour of continuous serving, counting output tokens only (conservative)."""
    return tokens_per_sec * SECONDS_PER_HOUR * output_per_mtok / MTOK

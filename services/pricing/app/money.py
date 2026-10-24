"""Decimal helpers. Money never touches float in this service."""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation

Q6 = Decimal("0.000001")
Q2 = Decimal("0.01")


def to_dec(value: str | int | Decimal) -> Decimal:
    """Parse a money/quantity input. Rejects floats so binary rounding cannot sneak in."""
    if isinstance(value, float):
        raise TypeError("floats are not accepted for money; pass a decimal string")
    try:
        d = Decimal(str(value))
    except InvalidOperation as e:
        raise ValueError(f"not a decimal: {value!r}") from e
    if not d.is_finite():
        raise ValueError(f"not a finite decimal: {value!r}")
    return d


def floor6(d: Decimal) -> Decimal:
    return d.quantize(Q6, rounding=ROUND_DOWN)


def ceil6(d: Decimal) -> Decimal:
    return d.quantize(Q6, rounding=ROUND_CEILING)


def round6(d: Decimal) -> Decimal:
    return d.quantize(Q6, rounding=ROUND_HALF_UP)


def s6(d: Decimal) -> str:
    """Format as a 6-decimal string, e.g. "12.500000". Expects an already-rounded value."""
    return f"{round6(d):.6f}"


def s2(d: Decimal) -> str:
    return f"{d.quantize(Q2, rounding=ROUND_HALF_UP):.2f}"


def has_at_most_6dp(d: Decimal) -> bool:
    return d == d.quantize(Q6)


def clamp(d: Decimal, lo: Decimal, hi: Decimal) -> Decimal:
    return max(lo, min(hi, d))

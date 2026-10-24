"""Deterministic loan pricing. USDC calculations stay in Decimal throughout."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from app.config import Settings
from app.models import CreditProfile, QuoteRequest

D = Decimal
YEAR_SECONDS = D(365 * 24 * 60 * 60)
Q6 = D("0.000001")

GRADE_BASE_APR: dict[str, Decimal] = {
    "A": D("0.050000"),
    "B": D("0.080000"),
    "C": D("0.120000"),
    "D": D("0.180000"),
    "E": D("0.300000"),
}
GRADE_MAX_LTV: dict[str, Decimal] = {
    "A": D("0.650000"),
    "B": D("0.550000"),
    "C": D("0.450000"),
    "D": D("0.350000"),
    "E": D("0.200000"),
}
GRADE_PD: dict[str, Decimal] = {
    "A": D("0.010000"),
    "B": D("0.030000"),
    "C": D("0.080000"),
    "D": D("0.200000"),
    "E": D("0.400000"),
}


def money6(value: Decimal) -> str:
    return format(value.quantize(Q6, rounding=ROUND_HALF_UP), ".6f")


def ratio6(value: Decimal) -> str:
    return format(value.quantize(Q6, rounding=ROUND_HALF_UP), ".6f")


def clamp(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return max(low, min(value, high))


def mean_absolute_price_change(history: list[Any]) -> Decimal:
    points = sorted(history, key=lambda point: point.timestamp)
    changes: list[Decimal] = []
    for before, after in zip(points, points[1:]):
        if before.price > 0:
            changes.append(abs(after.price - before.price) / before.price)
    return sum(changes, D(0)) / D(len(changes)) if changes else D(0)


def projected_dividends(request: QuoteRequest, term_seconds: int) -> Decimal:
    total_revenue = D(0)
    total_seconds = D(0)
    for bucket in request.revenue_history:
        seconds = D(str((bucket.end - bucket.start).total_seconds()))
        if seconds > 0:
            total_revenue += bucket.revenue
            total_seconds += seconds
    if total_seconds == 0:
        return D(0)
    gross_projection = total_revenue / total_seconds * D(term_seconds)
    distributable = gross_projection * D("0.85") * D("0.95")
    return distributable * request.collateral_shares / D(1000)


def estimate_pd(
    *,
    score: int,
    grade: str,
    confidence: Decimal,
    coverage_ratio: Decimal,
    ltv: Decimal,
    max_ltv: Decimal,
) -> Decimal:
    score_component = D(100 - score) / D(100) * D("0.10")
    confidence_component = (D(1) - confidence) * D("0.05")
    coverage_component = max(D(0), D(1) - coverage_ratio) * D("0.15")
    leverage_component = max(D(0), ltv - max_ltv) * D("0.20")
    return clamp(
        GRADE_PD[grade] + score_component + confidence_component + coverage_component + leverage_component,
        D("0.001000"),
        D("0.990000"),
    )


def calculate_quote(request: QuoteRequest, settings: Settings) -> dict[str, Any]:
    term_seconds = request.term_seconds or settings.default_term_seconds
    if term_seconds <= 0:
        raise ValueError("termSeconds must be positive")

    profile = request.credit_profile
    collateral_value = request.collateral_shares * request.collateral_price
    ltv = request.principal / collateral_value
    volatility = mean_absolute_price_change(request.collateral_price_history)
    volatility_penalty = min(D("0.200000"), volatility * D(2))
    confidence_factor = D("0.750000") + D("0.250000") * profile.confidence
    preliminary_max_ltv = max(
        D(0), GRADE_MAX_LTV[profile.grade] * confidence_factor - volatility_penalty
    )

    apr = GRADE_BASE_APR[profile.grade] + D(100 - profile.score) / D(100) * D("0.060000")
    payment_due = request.principal * (
        D(1) + apr * D(term_seconds) / YEAR_SECONDS
    )
    expected_dividends = projected_dividends(request, term_seconds)
    coverage_ratio = expected_dividends / payment_due if payment_due > 0 else D(0)
    max_ltv = preliminary_max_ltv * min(D(1), coverage_ratio)

    margin_call_ltv = min(D("0.850000"), max_ltv + D("0.150000"))
    liquidation_ltv = min(D("0.950000"), max_ltv + D("0.300000"))
    pd = estimate_pd(
        score=profile.score,
        grade=profile.grade,
        confidence=profile.confidence,
        coverage_ratio=coverage_ratio,
        ltv=ltv,
        max_ltv=max_ltv,
    )
    recovery_fraction = min(D(1), collateral_value * D("0.90") / request.principal)
    loss_given_default = D(1) - recovery_fraction
    expected_loss = request.principal * pd * loss_given_default

    reasons: list[str] = []
    if ltv > max_ltv:
        reasons.append("LTV_ABOVE_MAX")
    if coverage_ratio < 1:
        reasons.append("LOW_DIVIDEND_COVERAGE")
    if profile.confidence < D("0.500000"):
        reasons.append("THIN_CREDIT_FILE")
    if volatility >= D("0.050000"):
        reasons.append("HIGH_COLLATERAL_VOLATILITY")
    if profile.grade == "E":
        reasons.append("HIGHEST_RISK_GRADE")

    return {
        "decision": "approve" if ltv <= max_ltv else "decline",
        "ltv": ratio6(ltv),
        "maxLtv": ratio6(max_ltv),
        "apr": ratio6(apr),
        "marginCallLtv": ratio6(margin_call_ltv),
        "liquidationLtv": ratio6(liquidation_ltv),
        "termSeconds": term_seconds,
        "paymentIntervalSeconds": min(settings.payment_interval_seconds, term_seconds),
        "pd": ratio6(pd),
        "expectedLoss": money6(expected_loss),
        "coverageRatio": ratio6(coverage_ratio),
        "reasons": reasons,
    }


def base_pd_for_profile(profile: CreditProfile) -> Decimal:
    """Credit-only PD estimate for deterministic book simulations."""
    return clamp(
        GRADE_PD[profile.grade]
        + D(100 - profile.score) / D(100) * D("0.10")
        + (D(1) - profile.confidence) * D("0.05"),
        D("0.001000"),
        D("0.990000"),
    )


def rate_curve() -> dict[str, Any]:
    ltv_points = [D("0.250000"), D("0.400000"), D("0.550000"), D("0.700000"), D("0.850000")]
    representative_scores = {"A": 90, "B": 80, "C": 65, "D": 50, "E": 25}
    grades: list[dict[str, Any]] = []
    for grade in ("A", "B", "C", "D", "E"):
        score = representative_scores[grade]
        base = GRADE_BASE_APR[grade] + D(100 - score) / D(100) * D("0.060000")
        base_ltv = GRADE_MAX_LTV[grade]
        points = []
        for ltv in ltv_points:
            leverage_premium = max(D(0), ltv - base_ltv) * D("0.100000")
            points.append({"ltv": ratio6(ltv), "apr": ratio6(base + leverage_premium)})
        grades.append({"grade": grade, "points": points})
    return {"grades": grades, "simulated": True}

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.config import Settings
from app.models import QuoteRequest
from app.risk import calculate_quote


def make_request(
    *,
    score: int = 82,
    grade: str = "B",
    confidence: str = "0.900000",
    principal: str = "40.000000",
    revenue: str = "120.000000",
    history_prices: tuple[str, ...] = ("1.000000", "1.000000"),
) -> QuoteRequest:
    now = datetime(2026, 10, 24, tzinfo=UTC)
    price_history = [
        {"timestamp": (now - timedelta(days=len(history_prices) - i - 1)).isoformat(), "price": p}
        for i, p in enumerate(history_prices)
    ]
    return QuoteRequest.model_validate(
        {
            "borrower": "rExampleBorrower",
            "gpuId": "gpu-a",
            "collateralShares": "100.000000",
            "principal": principal,
            "termSeconds": 600,
            "creditProfile": {
                "address": "rExampleBorrower",
                "network": "testnet",
                "score": score,
                "grade": grade,
                "confidence": confidence,
                "features": {},
                "evidence": [],
                "reasons": [],
            },
            "revenueHistory": [
                {
                    "start": (now - timedelta(days=1)).isoformat(),
                    "end": now.isoformat(),
                    "revenue": revenue,
                    "bookedMinutes": 480,
                    "inferenceMinutes": 600,
                    "idleMinutes": 360,
                    "utilizationPct": "75.000000",
                    "simulated": True,
                }
            ],
            "collateralPrice": "1.000000",
            "collateralPriceHistory": price_history,
        }
    )


def test_higher_score_reduces_apr() -> None:
    settings = Settings()
    lower_score = calculate_quote(make_request(score=70), settings)
    higher_score = calculate_quote(make_request(score=90), settings)

    assert Decimal(higher_score["apr"]) < Decimal(lower_score["apr"])


def test_higher_price_volatility_reduces_max_ltv() -> None:
    settings = Settings()
    calm = calculate_quote(make_request(history_prices=("1.000000", "1.000000")), settings)
    volatile = calculate_quote(make_request(history_prices=("0.700000", "1.000000")), settings)

    assert Decimal(volatile["maxLtv"]) < Decimal(calm["maxLtv"])
    assert "HIGH_COLLATERAL_VOLATILITY" in volatile["reasons"]


def test_low_dividend_coverage_cuts_max_ltv() -> None:
    settings = Settings()
    healthy_coverage = calculate_quote(make_request(revenue="120000.000000"), settings)
    weak_coverage = calculate_quote(make_request(revenue="120.000000"), settings)

    assert Decimal(weak_coverage["coverageRatio"]) < 1
    assert Decimal(weak_coverage["maxLtv"]) < Decimal(healthy_coverage["maxLtv"])
    assert "LOW_DIVIDEND_COVERAGE" in weak_coverage["reasons"]


def test_ltv_above_max_is_declined() -> None:
    result = calculate_quote(make_request(principal="80.000000", revenue="120000.000000"), Settings())

    assert result["decision"] == "decline"
    assert "LTV_ABOVE_MAX" in result["reasons"]


def normal_round_request(grade="B", principal="105.000000"):
    req = make_request(grade=grade, principal=principal, revenue="48.200000")
    return req.model_copy(update={"term_seconds": 14 * 86400, "collateral_price": Decimal("5.25")})


def test_grade_b_real_round_calibration_and_schedule():
    result = calculate_quote(normal_round_request(), Settings())
    assert result["decision"] == "approve"
    assert result["ltv"] == "0.200000"
    assert Decimal("0.45") <= Decimal(result["maxLtv"]) <= Decimal("0.50")
    assert Decimal("0.60") <= Decimal(result["marginCallLtv"]) <= Decimal("0.65")
    assert Decimal("0.75") <= Decimal(result["liquidationLtv"]) <= Decimal("0.80")
    assert result["paymentIntervalSeconds"] == 40320
    assert calculate_quote(normal_round_request(principal="100"), Settings())["decision"] == "approve"


def test_grade_e_at_forty_percent_declines():
    req = normal_round_request("E", "210").model_copy(update={
        "credit_profile": make_request(grade="E", score=25).credit_profile,
    })
    result = calculate_quote(req, Settings())
    assert result["decision"] == "decline"
    assert Decimal(result["maxLtv"]) <= Decimal("0.20")
    assert "HIGHEST_RISK_GRADE" in result["reasons"]


def test_thirty_percent_shock_crosses_margin_on_45_percent_loan():
    result = calculate_quote(normal_round_request(principal="236.25"), Settings())
    assert result["decision"] == "approve"
    shocked_ltv = Decimal("0.45") / Decimal("0.70")
    assert Decimal(result["marginCallLtv"]) < shocked_ltv < Decimal(result["liquidationLtv"])


def test_capacity_does_not_depend_on_requested_principal():
    small = calculate_quote(normal_round_request(principal="100"), Settings())
    large = calculate_quote(normal_round_request(principal="250"), Settings())
    assert small["maxLtv"] == large["maxLtv"]


def test_schedule_rounds_up_and_respects_configured_interval():
    from dataclasses import replace
    req = normal_round_request().model_copy(update={"term_seconds": 1209601})
    assert calculate_quote(req, Settings())["paymentIntervalSeconds"] == 40321
    assert calculate_quote(req, replace(Settings(), payment_interval_seconds=50000))["paymentIntervalSeconds"] == 50000

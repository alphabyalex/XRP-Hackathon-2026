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

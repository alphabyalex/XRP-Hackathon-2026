"""Credit memo inputs as people read them: money with 2 decimals and a unit (200.00 USDC), rates
as percents (34.08%), coverage as a multiple (1.18x), terms in days. The memo is written from
these, and the number guard accepts them next to the raw values."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any


def _d(v: Any) -> Decimal | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def money(v: Any, unit: str = "USDC") -> str | None:
    d = _d(v)
    return None if d is None else f"{d:,.2f} {unit}"


def pct(v: Any) -> str | None:
    d = _d(v)
    return None if d is None else f"{d * 100:.2f}%"


def multiple(v: Any) -> str | None:
    d = _d(v)
    return None if d is None else f"{d:.2f}x"


def days(seconds: Any) -> str | None:
    d = _d(seconds)
    if d is None:
        return None
    n = d / 86400
    return f"{n:.0f} days" if n == n.to_integral_value() else f"{n:.1f} days"


def count(v: Any) -> str | None:
    d = _d(v)
    if d is None:
        return None
    return f"{d:.0f}" if d == d.to_integral_value() else f"{d.normalize():f}"


def _feature(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name.endswith("Xrp"):
        return money(value, "XRP")
    if name.endswith("Ratio"):
        return pct(value)
    if name == "balanceStability":
        d = _d(value)
        return None if d is None else f"{d:.2f}"
    return count(value) if _d(value) is not None else value


def present(credit_profile: dict, quote: dict, loan_request: dict) -> dict[str, Any]:
    """The memo's inputs, formatted. Addresses and raw fractions are left out on purpose."""
    unit = loan_request.get("currency") or "USDC"
    shares = count(loan_request.get("collateralShares") or loan_request.get("collateral_shares"))
    gpu = (loan_request.get("gpuId") or loan_request.get("gpu_id") or "GPU").upper()
    term = loan_request.get("termSeconds") or loan_request.get("term_seconds") or quote.get("termSeconds")
    features = {
        k: _feature(k, f.get("value") if isinstance(f, dict) else f)
        for k, f in (credit_profile.get("features") or {}).items()
    }
    out = {
        "borrower": {
            "score": credit_profile.get("score"),
            "grade": credit_profile.get("grade"),
            "confidence": credit_profile.get("confidence"),
            "reasons": list(credit_profile.get("reasons") or [])[:6],
            "factors": {k: v for k, v in features.items() if v is not None},
        },
        "loan": {
            "principal": money(loan_request.get("principal") or quote.get("principal"), unit),
            "collateral": f"{shares} {gpu} shares" if shares else None,
            "term": days(term),
        },
        "quote": {
            "decision": quote.get("decision"),
            "apr": pct(quote.get("apr")),
            "ltv": pct(quote.get("ltv")),
            "maxLtv": pct(quote.get("maxLtv") or quote.get("max_ltv")),
            "marginCallLtv": pct(quote.get("marginCallLtv")),
            "liquidationLtv": pct(quote.get("liquidationLtv") or quote.get("liquidation_ltv")),
            "defaultProbability": pct(quote.get("pd")),
            "dividendCoverage": multiple(quote.get("coverageRatio")),
            "expectedLoss": money(quote.get("expectedLoss"), unit),
            "riskFlags": list(quote.get("reasons") or []),
        },
    }
    for part in out.values():
        for k in [k for k, v in part.items() if v is None]:
            del part[k]
    return out

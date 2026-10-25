"""Deterministic explanations. Used when MOCK=1, when Bedrock fails, or when guardrails reject it."""

from __future__ import annotations

FLAG_SENTENCES = {
    "REVENUE_SPIKE": "Revenue is well above its recent average, so check it before approving.",
    "LOW_UTILIZATION": "Utilization is low, so the GPU sat idle for much of the period.",
    "CONCENTRATED_HOLDER": "One holder owns more than 40% of all shares.",
    "HIGH_LTV": "The loan is close to the maximum loan-to-value.",
    "ZERO_REVENUE": "The GPU earned nothing this period, so there is nothing to distribute.",
    "NO_HOLDERS": "No outside holders are eligible, so the full amount stays in the treasury.",
    "SYSTEM_ACCOUNT_EXCLUDED": "Treasury and issuer accounts were excluded from payouts.",
    "FLOOR_PRICE_BINDING": "The price is set by the inference floor rather than market demand.",
    "NEGATIVE_NET_REVENUE": "Expected costs exceed expected revenue at current utilization.",
}


def _g(data: dict, key: str, default: str = "?") -> str:
    v = data.get(key)
    return default if v is None else str(v)


def _flags(flags: list[str]) -> list[str]:
    return [FLAG_SENTENCES[f] for f in flags if f in FLAG_SENTENCES]


def dividend(data: dict, flags: list[str]) -> str:
    gpu = _g(data, "gpu_label", _g(data, "gpu_id", "this GPU"))
    payouts = data.get("payouts") or []
    s = [
        f"This period {gpu} earned {_g(data, 'gross_revenue')} TDX in gross revenue.",
        f"The hosting fee takes {_g(data, 'hosting_fee')} TDX ({_g(data, 'hosting_fee_pct')}%) and "
        f"{_g(data, 'reserve')} TDX ({_g(data, 'reserve_pct')}%) of the rest goes to the treasury reserve, "
        f"leaving {_g(data, 'distributable')} TDX to distribute.",
    ]
    if payouts:
        s.append(
            f"Each share earns {_g(data, 'per_share')} TDX, so {len(payouts)} holders receive "
            f"{_g(data, 'total_paid')} TDX in total, and {_g(data, 'dust')} TDX stays in the treasury "
            "for unsold shares and rounding."
        )
    return " ".join(s + _flags(flags))


def nav(data: dict, flags: list[str]) -> str:
    s = [
        f"NAV is {_g(data, 'nav_per_share')} TDX per share: {_g(data, 'treasury_cash')} TDX of treasury "
        f"cash plus {_g(data, 'pv_future_net')} TDX of discounted future net revenue.",
        f"The model assumes {_g(data, 'utilization_assumption')}% utilization over the GPU's remaining life.",
        f"Trailing 24 hour revenue is {_g(data, 'trailing_revenue_24h')} TDX and the implied yield is "
        f"{_g(data, 'implied_yield_pct')}%.",
    ]
    return " ".join(s + _flags(flags))


def loan(data: dict, flags: list[str]) -> str:
    s = [
        f"Locking {_g(data, 'shares')} shares worth {_g(data, 'collateral_value')} TDX supports a loan of "
        f"up to {_g(data, 'max_principal')} TDX.",
        f"Borrowing {_g(data, 'principal')} TDX for {_g(data, 'term_minutes')} minutes costs "
        f"{_g(data, 'interest')} TDX in interest, so {_g(data, 'amount_due')} TDX is due at maturity.",
        f"If the collateral value falls to {_g(data, 'liquidation_value')} TDX the loan reaches its "
        "liquidation threshold.",
    ]
    return " ".join(s + _flags(flags))


def credit_memo(credit_profile: dict, quote: dict, loan_request: dict) -> str:
    from app.agent.memo_format import present

    p = present(credit_profile, quote, loan_request)
    b, loan, q = p["borrower"], p["loan"], p["quote"]
    s = [
        f"The borrower holds Grade {b.get('grade', 'N/A')} credit with a score of {b.get('score', 'unrated')}.",
        f"The requested loan of {loan.get('principal', 'the requested amount')} is secured by {loan.get('collateral', 'GPU shares')}.",
        f"The loan opens at {q.get('ltv', 'its')} LTV against a maximum of {q.get('maxLtv', 'the limit')}.",
        f"Terms are {q.get('apr', 'the quoted rate')} APR for {loan.get('term', 'the term')}, "
        f"with an estimated default probability of {q.get('defaultProbability', 'n/a')}.",
        f"Liquidation starts if LTV reaches {q.get('liquidationLtv', 'the liquidation line')}.",
    ]
    return " ".join(s)


def risk_alert(event: dict) -> str:
    from app.agent.memo_format import present_alert

    e = present_alert(event)
    ltv = e.get("ltv", "its limit")
    gpu = e.get("gpu", "GPU")
    balance = e.get("outstandingBalance", "the outstanding balance")
    if e["type"] == "liquidation":
        return (
            f"Your loan reached the liquidation line of {e.get('liquidationLtv', 'its limit')} with an LTV of {ltv}. "
            f"Your {gpu} shares are being sold to repay the outstanding balance of {balance}."
        )
    return (
        f"Margin call on your loan. Its loan-to-value ratio rose to {ltv}, above the margin call line of {e.get('marginCallLtv', 'its limit')}. "
        f"Add collateral or pay down principal on your outstanding balance of {balance} to avoid liquidation at {e.get('liquidationLtv', 'the liquidation line')}."
    )


TEMPLATES = {"dividend": dividend, "nav": nav, "loan": loan}


def explain(context: str, data: dict, flags: list[str]) -> str:
    return TEMPLATES[context](data, flags)

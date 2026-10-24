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
    borrower = loan_request.get("borrower") or credit_profile.get("address") or "the borrower"
    score = credit_profile.get("score", "unrated")
    grade = credit_profile.get("grade", "N/A")
    principal = loan_request.get("principal") or quote.get("principal") or "0"
    collateral_shares = loan_request.get("collateralShares") or loan_request.get("collateral_shares") or "0"
    gpu_id = loan_request.get("gpuId") or loan_request.get("gpu_id") or "GPU"
    apr = quote.get("apr", "0")
    ltv = quote.get("ltv", "0")
    max_ltv = quote.get("maxLtv") or quote.get("max_ltv") or "0"
    liquidation_ltv = quote.get("liquidationLtv") or quote.get("liquidation_ltv") or "0"
    term_seconds = (
        loan_request.get("termSeconds")
        or loan_request.get("term_seconds")
        or quote.get("termSeconds")
        or "600"
    )
    pd = quote.get("pd", "0")

    s = [
        f"Borrower {borrower} holds Grade {grade} credit with a score of {score}.",
        f"The requested loan of {principal} TDX is secured by {collateral_shares} shares of {gpu_id}.",
        f"The loan offers an initial LTV of {ltv} against a maximum LTV limit of {max_ltv}.",
        f"Terms specify an APR of {apr} for {term_seconds} seconds with an estimated default probability of {pd}.",
        f"Liquidation is scheduled if LTV rises to {liquidation_ltv}.",
    ]
    return " ".join(s)


def risk_alert(event: dict) -> str:
    event_type = event.get("type", "margin_call")
    loan_id = event.get("loanId") or event.get("loan_id") or "loan"
    ltv = event.get("ltv", "0")
    threshold = (
        event.get("thresholdLtv")
        or event.get("marginCallLtv")
        or event.get("margin_call_ltv")
        or "0"
    )
    liq_threshold = event.get("liquidationLtv") or event.get("liquidation_ltv") or "0"
    balance = event.get("outstandingBalance") or event.get("outstanding_balance") or "0"
    gpu_id = event.get("gpuId") or event.get("gpu_id") or "GPU"

    if event_type == "liquidation":
        return (
            f"Loan {loan_id} has breached the liquidation threshold of {liq_threshold or threshold} with an LTV of {ltv}. "
            f"Collateral shares of {gpu_id} are being liquidated to satisfy the outstanding balance of {balance} TDX."
        )
    return (
        f"A margin call has been issued for loan {loan_id}. "
        f"The current loan-to-value ratio has risen to {ltv}, crossing the margin call threshold of {threshold}. "
        f"Please deposit additional collateral or pay down principal on your outstanding balance of {balance} TDX to prevent liquidation."
    )


TEMPLATES = {"dividend": dividend, "nav": nav, "loan": loan}


def explain(context: str, data: dict, flags: list[str]) -> str:
    return TEMPLATES[context](data, flags)

"""Glue between config and the pure models. Builds contract-shaped numbers; no new math here."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app import config as C
from app.models import contract, dividends, inference, loans, nav, risk
from app.money import s2, s6

D = Decimal


def gpu(gpu_id: str) -> C.GpuSpec:
    try:
        return C.GPUS[gpu_id]
    except KeyError:
        raise ValueError(f"unknown gpu_id {gpu_id!r}; expected one of {sorted(C.GPUS)}") from None


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _ref_source(hw_class: str) -> dict:
    for row in C.load_reference_prices()["gpus"]:
        if row["gpu"] == hw_class:
            return {"name": f"AWS {row['instance']} on-demand", "url": row["source_url"], "retrieved": row["retrieved"]}
    return {}


# ---- Rate card ------------------------------------------------------------------------


def _rate_card(spec: C.GpuSpec, utilization_pct: Decimal) -> inference.RateCard:
    return inference.rate_card(
        hourly_cost=C.reference_hourly(spec.hw_class),
        tokens_per_sec=C.TOKENS_PER_SEC,
        utilization_pct=utilization_pct,
        margin=C.INFERENCE_MARGIN,
        input_ratio=C.INPUT_TO_OUTPUT_RATIO,
        surcharge_start=C.SURCHARGE_START_UTIL,
        surcharge_full=C.SURCHARGE_FULL_UTIL,
        surcharge_max=C.SURCHARGE_MAX,
        base_fee=C.INFERENCE_BASE_FEE,
    )


def inference_rates(gpu_id: str, utilization_pct: Decimal | None, now: datetime) -> dict:
    spec = gpu(gpu_id)
    util = C.DEFAULT_UTILIZATION_PCT if utilization_pct is None else utilization_pct
    card = _rate_card(spec, util)
    return {
        "input_per_mtok": s6(card.input_per_mtok),
        "output_per_mtok": s6(card.output_per_mtok),
        "base_fee": s6(card.base_fee),
        "currency": C.STABLE_CODE,
        "valid_until": _iso(now + timedelta(seconds=C.RATE_VALID_SECONDS)),
        "inputs": {
            "gpu_id": spec.id,
            "hourly_cost_usd": s6(C.reference_hourly(spec.hw_class)),
            "tokens_per_sec": str(C.TOKENS_PER_SEC),
            "tokens_per_sec_placeholder": C.TOKENS_PER_SEC_IS_PLACEHOLDER,
            "cost_floor_output_per_mtok": s6(card.floor_per_mtok),
            "margin_pct": s2(C.INFERENCE_MARGIN * 100),
            "input_to_output_ratio": str(C.INPUT_TO_OUTPUT_RATIO),
            "utilization_pct": s2(util),
            "utilization_is_default": utilization_pct is None,
            "utilization_surcharge_pct": s2(card.surcharge * 100),
            "simulated_gpu": spec.simulated,
        },
    }


# ---- Slot contract price --------------------------------------------------------------


def contract_price(
    gpu_id: str,
    slot_start: datetime,
    now: datetime,
    utilization_pct: Decimal | None,
    booked_share_24h: Decimal | None,
) -> dict:
    spec = gpu(gpu_id)
    util = C.DEFAULT_UTILIZATION_PCT if utilization_pct is None else utilization_pct
    booked = C.DEFAULT_BOOKED_SHARE_24H if booked_share_24h is None else booked_share_24h
    ref = C.reference_hourly(spec.hw_class)
    card = _rate_card(spec, util)
    lead_hours = D(str((slot_start - now).total_seconds())) / D(3600)
    p = contract.contract_price(
        reference_hourly=ref,
        slot_minutes=C.SLOT_MINUTES,
        booked_share_24h=booked,
        lead_hours=lead_hours,
        utilization_pct=util,
        inference_revenue_per_hour=inference.full_load_revenue_per_hour(card.output_per_mtok, C.TOKENS_PER_SEC),
        marginal_cost_per_hour=C.POWER_COST_PER_HOUR,
        scarcity_max=C.SCARCITY_MAX,
        lead_discount_max=C.LEAD_DISCOUNT_MAX,
        lead_discount_start_hours=C.LEAD_DISCOUNT_START_HOURS,
        lead_discount_full_hours=C.LEAD_DISCOUNT_FULL_HOURS,
    )
    return {
        "price_per_slot": s6(p.price_per_slot),
        "slot_minutes": C.SLOT_MINUTES,
        "reference_hourly_usd": s6(ref),
        "components": {
            "base": s6(p.base),
            "scarcity_premium_pct": s2(p.scarcity_premium_pct),
            "lead_time_discount_pct": s2(p.lead_time_discount_pct),
            "market_price": s6(p.market_price),
            "marginal_cost": s6(p.marginal_cost),
            "expected_inference_revenue": s6(p.expected_inference_revenue),
            "idle_sell_probability": s2(p.idle_sell_probability),
            "forgone_inference": s6(p.forgone_inference),
            "floor": s6(p.floor),
            "floor_binding": p.floor_binding,
            "lead_hours": s2(lead_hours),
            "booked_share_24h": s2(booked),
            "utilization_pct": s2(util),
            "inputs_are_default": utilization_pct is None or booked_share_24h is None,
        },
        "valid_until": _iso(now + timedelta(seconds=C.CONTRACT_VALID_SECONDS)),
        "sources": [_ref_source(spec.hw_class)],
    }


# ---- NAV --------------------------------------------------------------------------------


def nav_numbers(spec: C.GpuSpec, treasury_cash: Decimal, utilization_pct: Decimal) -> nav.NavResult:
    card = _rate_card(spec, utilization_pct)
    blended = nav.blended_revenue_per_hour(
        contract_hourly=C.reference_hourly(spec.hw_class),
        inference_hourly=inference.full_load_revenue_per_hour(card.output_per_mtok, C.TOKENS_PER_SEC),
        booked_fraction=C.BOOKED_FRACTION,
    )
    return nav.nav(
        treasury_cash=treasury_cash,
        utilization_pct=utilization_pct,
        blended_revenue_per_hour=blended,
        hosting_fee_bps=C.HOSTING_FEE_BPS,
        power_cost_per_hour=C.POWER_COST_PER_HOUR,
        life_months=C.USEFUL_LIFE_MONTHS,
        discount_rate_annual=C.DISCOUNT_RATE_ANNUAL,
        hours_per_month=C.HOURS_PER_MONTH,
        shares_total=spec.shares_total,
        util_min=C.UTIL_CLIP_MIN,
        util_max=C.UTIL_CLIP_MAX,
    )


def nav_response(
    gpu_id: str,
    treasury_cash: Decimal | None,
    utilization_pct: Decimal | None,
    trailing_revenue_24h: Decimal | None,
    trailing_dividends_per_share: Decimal | None,
    trailing_period_days: Decimal | None,
    share_price: Decimal | None,
) -> dict:
    spec = gpu(gpu_id)
    cash = C.DEFAULT_TREASURY_CASH if treasury_cash is None else treasury_cash
    util = C.DEFAULT_UTILIZATION_PCT if utilization_pct is None else utilization_pct
    r = nav_numbers(spec, cash, util)
    price = share_price if share_price is not None else r.nav_per_share
    yld = nav.implied_yield_pct(
        trailing_dividends_per_share or D(0), trailing_period_days or D(1), price
    )
    return {
        "nav_per_share": s6(r.nav_per_share),
        "treasury_cash": s6(cash),
        "pv_future_net": s6(r.pv_future_net),
        "utilization_assumption": s2(r.utilization_used_pct),
        "trailing_revenue_24h": s6(trailing_revenue_24h or D(0)),
        "implied_yield_pct": s2(yld),
        "inputs": {
            "gpu_id": spec.id,
            "shares_total": spec.shares_total,
            "utilization_input_pct": s2(util),
            "utilization_is_default": utilization_pct is None,
            "utilization_clip_pct": [s2(C.UTIL_CLIP_MIN), s2(C.UTIL_CLIP_MAX)],
            "booked_fraction": str(C.BOOKED_FRACTION),
            "hosting_fee_bps": C.HOSTING_FEE_BPS,
            "power_cost_per_hour": s6(C.POWER_COST_PER_HOUR),
            "net_revenue_per_hour": s6(r.net_revenue_per_hour),
            "net_revenue_per_month": s6(r.net_revenue_per_month),
            "useful_life_months": C.USEFUL_LIFE_MONTHS,
            "discount_rate_annual_pct": s2(C.DISCOUNT_RATE_ANNUAL * 100),
            "share_price_used": s6(price),
            "share_price_is_nav": share_price is None,
            "placeholders": ["power_cost_per_hour", "booked_fraction", "useful_life_months",
                             "discount_rate_annual_pct", "tokens_per_sec"],
        },
    }


# ---- Dividends -------------------------------------------------------------------------


def dividend_numbers(
    gpu_id: str,
    gross_revenue: Decimal,
    holders: list[tuple[str, Decimal]],
    utilization_pct: Decimal | None,
    trailing_avg_gross: Decimal | None,
) -> tuple[dict, list[str]]:
    spec = gpu(gpu_id)
    r = dividends.propose(
        gross_revenue=gross_revenue,
        holders=holders,
        shares_total=spec.shares_total,
        excluded=C.SYSTEM_ACCOUNT_NAMES | C.system_addresses(),
        hosting_fee_bps=C.HOSTING_FEE_BPS,
        reserve_bps=C.RESERVE_BPS,
        denominator=C.DIVIDEND_DENOMINATOR,
    )
    flags = risk.dividend_flags(
        gross_revenue=gross_revenue,
        holder_shares=[p.shares for p in r.payouts],
        shares_total=spec.shares_total,
        excluded_count=len(r.excluded_accounts),
        concentrated_pct=C.CONCENTRATED_HOLDER_PCT,
        utilization_pct=utilization_pct,
        low_util_pct=C.LOW_UTILIZATION_PCT,
        trailing_avg_gross=trailing_avg_gross,
        spike_multiple=C.REVENUE_SPIKE_MULTIPLE,
    )
    body = {
        "gross_revenue": s6(r.gross_revenue),
        "hosting_fee": s6(r.hosting_fee),
        "reserve": s6(r.reserve),
        "distributable": s6(r.distributable),
        "payouts": [{"account": p.account, "amount": s6(p.amount)} for p in r.payouts],
        "total_paid": s6(sum((p.amount for p in r.payouts), D(0))),
        "dust": s6(r.dust),
        "per_share": s6(r.per_share),
        "treasury_retained": s6(r.treasury_retained),
        "rounding_dust": s6(r.rounding_dust),
        "held_shares": str(r.held_shares),
        "shares_total": spec.shares_total,
        "hosting_fee_pct": s2(D(C.HOSTING_FEE_BPS) / 100),
        "reserve_pct": s2(D(C.RESERVE_BPS) / 100),
        "excluded_accounts": r.excluded_accounts,
    }
    return body, flags


# ---- Loans -------------------------------------------------------------------------------


def loan_numbers(
    gpu_id: str,
    shares: Decimal,
    nav_per_share: Decimal | None,
    principal: Decimal | None,
    term_minutes: int | None,
) -> tuple[dict, list[str]]:
    spec = gpu(gpu_id)
    nps = nav_per_share
    if nps is None:
        nps = nav_numbers(spec, C.DEFAULT_TREASURY_CASH, C.DEFAULT_UTILIZATION_PCT).nav_per_share
    q = loans.quote(
        nav_per_share=nps,
        shares=shares,
        max_ltv_bps=C.LOAN_MAX_LTV_BPS,
        liquidation_ltv_bps=C.LOAN_LIQUIDATION_LTV_BPS,
        apr_bps=C.LOAN_APR_BPS,
        term_minutes=term_minutes or C.LOAN_DEMO_TERM_MINUTES,
        principal=principal,
    )
    flags = risk.loan_flags(ltv_pct=q.ltv_pct, high_ltv_pct=C.HIGH_LTV_PCT) if principal is not None else []
    body = {
        "collateral_value": s6(q.collateral_value),
        "max_principal": s6(q.max_principal),
        "apr_bps": q.apr_bps,
        "liquidation_value": s6(q.liquidation_value),
        "term_minutes": q.term_minutes,
        "principal": s6(q.principal),
        "interest": s6(q.interest),
        "amount_due": s6(q.amount_due),
        "ltv_pct": s2(q.ltv_pct),
        "nav_per_share": s6(nps),
        "nav_is_default": nav_per_share is None,
        "shares": str(shares),
    }
    return body, flags


def resources_breakdown() -> dict[str, dict]:
    # Hosting metadata comes from the prepared GPU-A lease manifest. Component
    # prices are not published by the lease, so no allocation is invented.
    return {
        "gpu-a": {
            "provider": "Akash Network",
            "instance_type": "NVIDIA T4",
            "region": None,
            "components": {
                "gpu": {"label": "GPU Compute", "spec": "1x NVIDIA T4 16GB VRAM", "hourly_usd": None},
                "cpu": {"label": "vCPU Compute", "spec": "4 vCPUs", "hourly_usd": None},
                "ram": {"label": "System Memory", "spec": "16 GiB", "hourly_usd": None},
                "storage": {"label": "Storage", "spec": "50 GiB", "hourly_usd": None},
            },
            "total_hourly_usd": None,
            "monthly_usd": None,
            "indexed_savings_vs_aws_pct": None,
            "pricing_endpoint": "/catalog/gpus",
        },
    }

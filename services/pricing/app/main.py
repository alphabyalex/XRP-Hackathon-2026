"""Moonshift pricing service (FastAPI, port 6000). Contract: A9.3 in docs/CONTRACTS.md."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import config as C
from app import pricing
from app.agent import bedrock
from app.money import to_dec

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Moonshift pricing", version="0.1.0")


@app.exception_handler(ValueError)
async def value_error(_: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": {"code": "INVALID_INPUT", "message": str(exc)}})


def internal_key(x_ms_internal_key: str | None = Header(default=None)) -> None:
    """Enforced only when INTERNAL_API_KEY is set, so local dev works without it."""
    if C.INTERNAL_API_KEY and x_ms_internal_key != C.INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="bad or missing X-MS-Internal-Key")


def _opt(v: str | None) -> Decimal | None:
    return None if v is None else to_dec(v)


def _now() -> datetime:
    return datetime.now(UTC)


def _parse_time(s: str) -> datetime:
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"not an ISO 8601 time: {s!r}") from None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


# ---- Request bodies ---------------------------------------------------------------------


class Holder(BaseModel):
    account: str
    shares: str


class DividendRequest(BaseModel):
    gpu_id: str
    period_start: str
    period_end: str
    gross_revenue: str
    holders: list[Holder]
    # Optional additions (proposed contract change): used only for risk flags.
    utilization_pct: str | None = None
    trailing_avg_gross: str | None = None


class LoanRequest(BaseModel):
    gpu_id: str
    shares: str
    # Optional additions (proposed contract change).
    nav_per_share: str | None = None
    principal: str | None = None
    term_minutes: int | None = None


class ExplainRequest(BaseModel):
    context: Literal["dividend", "nav", "loan"]
    data: dict = Field(default_factory=dict)


# ---- Endpoints -------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {"ok": True, "mock": C.MOCK, "bedrock_model": None if C.MOCK else C.BEDROCK_MODEL_ID}


@app.get("/rates/inference", dependencies=[Depends(internal_key)])
def rates_inference(gpu_id: str, utilization_pct: str | None = None) -> dict:
    return pricing.inference_rates(gpu_id, _opt(utilization_pct), _now())


@app.get("/price/contract", dependencies=[Depends(internal_key)])
def price_contract(
    gpu_id: str,
    slot_start: str,
    utilization_pct: str | None = None,
    booked_share_24h: str | None = None,
) -> dict:
    return pricing.contract_price(
        gpu_id, _parse_time(slot_start), _now(), _opt(utilization_pct), _opt(booked_share_24h)
    )


@app.get("/nav", dependencies=[Depends(internal_key)])
def get_nav(
    gpu_id: str,
    treasury_cash: str | None = None,
    utilization_pct: str | None = None,
    trailing_revenue_24h: str | None = None,
    trailing_dividends_per_share: str | None = None,
    trailing_period_days: str | None = None,
    share_price: str | None = None,
) -> dict:
    return pricing.nav_response(
        gpu_id,
        _opt(treasury_cash),
        _opt(utilization_pct),
        _opt(trailing_revenue_24h),
        _opt(trailing_dividends_per_share),
        _opt(trailing_period_days),
        _opt(share_price),
    )


@app.post("/dividends/propose", dependencies=[Depends(internal_key)])
def dividends_propose(req: DividendRequest) -> dict:
    body, flags = pricing.dividend_numbers(
        req.gpu_id,
        to_dec(req.gross_revenue),
        [(h.account, to_dec(h.shares)) for h in req.holders],
        _opt(req.utilization_pct),
        _opt(req.trailing_avg_gross),
    )
    spec = pricing.gpu(req.gpu_id)
    agent_data = {**body, "gpu_id": spec.id, "gpu_label": spec.label,
                  "period_start": req.period_start, "period_end": req.period_end}
    ex = bedrock.explain("dividend", agent_data, flags)
    return {**body, "explanation": ex.text, "risk_flags": ex.risk_flags, "explanation_source": ex.source}


@app.post("/loans/quote", dependencies=[Depends(internal_key)])
def loans_quote(req: LoanRequest) -> dict:
    body, flags = pricing.loan_numbers(
        req.gpu_id, to_dec(req.shares), _opt(req.nav_per_share), _opt(req.principal), req.term_minutes
    )
    return {**body, "risk_flags": flags}


@app.post("/agent/explain", dependencies=[Depends(internal_key)])
def agent_explain(req: ExplainRequest) -> dict:
    flags = [f for f in req.data.get("risk_flags", []) if isinstance(f, str)]
    data = {k: v for k, v in req.data.items() if k != "risk_flags"}
    ex = bedrock.explain(req.context, data, flags)
    return {"text": ex.text, "risk_flags": ex.risk_flags, "source": ex.source,
            "model_id": ex.model_id, "latency_ms": ex.latency_ms}

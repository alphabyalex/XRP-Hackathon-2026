"""Validated request models for the Risk Desk JSON contract."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class CreditProfile(ContractModel):
    address: str = Field(min_length=1)
    network: str = Field(min_length=1)
    score: int = Field(ge=0, le=100)
    grade: Literal["A", "B", "C", "D", "E"]
    confidence: Decimal = Field(ge=Decimal("0"), le=Decimal("1"))
    features: dict[str, Any] = Field(default_factory=dict)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)


class RevenueBucket(ContractModel):
    start: datetime
    end: datetime
    revenue: Decimal = Field(ge=Decimal("0"))
    booked_minutes: int = Field(alias="bookedMinutes", ge=0)
    inference_minutes: int = Field(alias="inferenceMinutes", ge=0)
    idle_minutes: int = Field(alias="idleMinutes", ge=0)
    utilization_pct: Decimal = Field(alias="utilizationPct", ge=Decimal("0"), le=Decimal("100"))
    simulated: bool

    @model_validator(mode="after")
    def valid_interval(self) -> RevenueBucket:
        if self.end <= self.start:
            raise ValueError("revenue bucket end must be after start")
        return self


class OraclePricePoint(ContractModel):
    timestamp: datetime
    price: Decimal = Field(gt=Decimal("0"))


class QuoteRequest(ContractModel):
    borrower: str = Field(min_length=1)
    gpu_id: str = Field(alias="gpuId", min_length=1)
    collateral_shares: Decimal = Field(alias="collateralShares", gt=Decimal("0"))
    principal: Decimal = Field(gt=Decimal("0"))
    term_seconds: int | None = Field(default=None, alias="termSeconds", gt=0)
    credit_profile: CreditProfile = Field(alias="creditProfile")
    revenue_history: list[RevenueBucket] = Field(alias="revenueHistory")
    collateral_price: Decimal = Field(alias="collateralPrice", gt=Decimal("0"))
    collateral_price_history: list[OraclePricePoint] = Field(alias="collateralPriceHistory")


class ScenarioRequest(ContractModel):
    gpu_price_shock_pct: Decimal = Field(alias="gpuPriceShockPct", ge=Decimal("-100"), le=Decimal("1000"))
    utilization_shock_pct: Decimal = Field(alias="utilizationShockPct", ge=Decimal("-100"), le=Decimal("100"))
    default_rate_multiplier: Decimal = Field(alias="defaultRateMultiplier", gt=Decimal("0"), le=Decimal("10"))


class OpenLoan(ContractModel):
    loan_id: str = Field(alias="loanId", min_length=1)
    borrower: str = Field(min_length=1)
    gpu_id: str = Field(alias="gpuId", min_length=1)
    collateral_shares: Decimal = Field(alias="collateralShares", gt=Decimal("0"))
    outstanding_balance: Decimal = Field(alias="outstandingBalance", ge=Decimal("0"))
    margin_call_ltv: Decimal = Field(alias="marginCallLtv", gt=Decimal("0"))
    liquidation_ltv: Decimal = Field(alias="liquidationLtv", gt=Decimal("0"))
    apr: Decimal = Field(default=Decimal("0.080000"), ge=Decimal("0"))
    status: str = "open"
    margin_call_at: datetime | None = Field(default=None, alias="marginCallAt")
    simulated: bool = False

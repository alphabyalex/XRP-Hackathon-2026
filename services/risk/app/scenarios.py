"""Isolated, visibly simulated stress scenarios for the live demo."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.config import Settings
from app.data import RiskDataClient
from app.events import EventLog
from app.keeper import Keeper
from app.models import ScenarioRequest
from app.risk import money6, ratio6

D = Decimal


class ScenarioDisabled(RuntimeError):
    """The demo shock flag is off outside mock mode."""


async def run_scenario(
    request: ScenarioRequest,
    settings: Settings,
    data: RiskDataClient,
    keeper: Keeper,
    events: EventLog,
) -> dict[str, Any]:
    if not settings.mock and not settings.demo_shock_enabled:
        raise ScenarioDisabled("stress scenarios require MOCK=1 or DEMO_SHOCK_ENABLED=1")

    price_factor = max(D("0.01"), D(1) + request.gpu_price_shock_pct / D(100))
    loans = await data.list_open_loans()
    multipliers = {loan.gpu_id: price_factor for loan in loans}
    keeper.apply_demo_shock(multipliers)

    total_loss = D(0)
    annual_interest = D(0)
    for loan in loans:
        if loan.status.lower() not in {"open", "active", "margin_call"}:
            continue
        price = await data.current_price(loan.gpu_id)
        stressed_collateral = loan.collateral_shares * price * price_factor
        if loan.outstanding_balance > 0:
            recovery = min(D(1), stressed_collateral * D("0.90") / loan.outstanding_balance)
            loss_given_default = D(1) - recovery
        else:
            loss_given_default = D(0)
        stressed_pd = min(D(1), loan.pd * request.default_rate_multiplier)
        total_loss += loan.outstanding_balance * stressed_pd * loss_given_default
        annual_interest += loan.outstanding_balance * loan.apr

    health = await keeper.check_once(force_dry_run=True)
    utilization_factor = max(
        D(0), min(D(2), D(1) + request.utilization_shock_pct / D(100))
    )
    deposits = D(settings.vault_deposits_usdc)
    cover = D(settings.first_loss_cover_usdc)
    cover_absorbed = min(total_loss, cover)
    before_apy = annual_interest / deposits if deposits > 0 else D(0)
    uncovered_loss = total_loss - cover_absorbed
    after_apy = max(D(0), before_apy * utilization_factor - uncovered_loss / deposits) if deposits > 0 else D(0)
    rows = [
        {
            "loanId": row["loanId"],
            "ltv": row["ltv"],
            "state": row["state"],
            "simulated": True,
        }
        for row in health["loans"]
    ]
    margin_calls = sum(row["state"] == "MARGIN_CALL" for row in rows)
    liquidations = sum(row["state"] == "LIQUIDATE" for row in rows)
    result = {
        "loans": rows,
        "marginCalls": margin_calls,
        "liquidations": liquidations,
        "vaultLoss": money6(total_loss),
        "firstLossCoverAbsorbed": money6(cover_absorbed),
        "lenderApyBefore": ratio6(before_apy),
        "lenderApyAfter": ratio6(after_apy),
        "simulated": True,
    }
    events.publish(
        "scenario_run",
        gpuPriceShockPct=str(request.gpu_price_shock_pct),
        utilizationShockPct=str(request.utilization_shock_pct),
        defaultRateMultiplier=str(request.default_rate_multiplier),
        marginCalls=margin_calls,
        liquidations=liquidations,
        vaultLoss=result["vaultLoss"],
        simulated=True,
    )
    return result

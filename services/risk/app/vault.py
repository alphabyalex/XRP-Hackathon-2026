"""Vault health summary from open loans and configured demo vault assumptions."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.config import Settings
from app.data import RiskDataClient
from app.risk import money6, ratio6

D = Decimal


async def vault_health(settings: Settings, data: RiskDataClient) -> dict[str, Any]:
    loans = [
        loan
        for loan in await data.list_open_loans()
        if loan.status.lower() in {"open", "active", "margin_call"}
    ]
    outstanding = sum((loan.outstanding_balance for loan in loans), D(0))
    weighted_interest = sum((loan.outstanding_balance * loan.apr for loan in loans), D(0))
    expected_loss = D(0)
    for loan in loans:
        if loan.outstanding_balance <= 0:
            continue
        price = await data.current_price(loan.gpu_id)
        collateral_value = loan.collateral_shares * price
        recovery = min(D(1), collateral_value * D("0.90") / loan.outstanding_balance)
        expected_loss += loan.outstanding_balance * loan.pd * (D(1) - recovery)

    deposits = D(settings.vault_deposits_usdc)
    cover = D(settings.first_loss_cover_usdc)
    utilization = outstanding / deposits if deposits > 0 else D(0)
    weighted_apr = weighted_interest / outstanding if outstanding > 0 else D(0)
    cover_ratio = ratio6(cover / expected_loss) if expected_loss > 0 else "UNBOUNDED"
    return {
        "activeLoans": len(loans),
        "vaultDeposits": money6(deposits),
        "outstandingPrincipal": money6(outstanding),
        "utilization": ratio6(utilization),
        "weightedAverageApr": ratio6(weighted_apr),
        "expectedLoss": money6(expected_loss),
        "firstLossCover": money6(cover),
        "coverRatio": cover_ratio,
        "simulated": True,
    }

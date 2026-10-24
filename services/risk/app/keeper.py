"""Margin-call keeper with persisted cure windows and a dry-run default."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.config import Settings
from app.data import RiskDataClient, UpstreamUnavailable
from app.events import EventLog
from app.models import OpenLoan
from app.risk import ratio6

D = Decimal


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


class Keeper:
    def __init__(self, settings: Settings, data: RiskDataClient, events: EventLog) -> None:
        self.settings = settings
        self.data = data
        self.events = events
        self.state_path = settings.state_dir / "keeper_state.json"
        self._state: dict[str, dict[str, Any]] = self._load_state()
        self._lock = asyncio.Lock()
        self._demo_price_multipliers: dict[str, Decimal] | None = None
        self._demo_shock_until: datetime | None = None
        self._last_health: dict[str, object] = {
            "checkedAt": None,
            "loans": [],
            "simulated": settings.mock,
        }

    def _load_state(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_state(self) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.state_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(self._state, separators=(",", ":")), encoding="utf-8")
            tmp_path.replace(self.state_path)
        except OSError:
            self.events.publish("keeper_state_error", reason="STATE_WRITE_FAILED", simulated=self.settings.mock)

    async def check_once(
        self,
        *,
        price_multipliers: dict[str, Decimal] | None = None,
        force_dry_run: bool = False,
    ) -> dict[str, object]:
        async with self._lock:
            now = datetime.now(UTC)
            demo_shock_active = False
            if price_multipliers is None and self._demo_shock_until is not None:
                if now < self._demo_shock_until:
                    price_multipliers = self._demo_price_multipliers
                    force_dry_run = True
                    demo_shock_active = True
                else:
                    self.events.publish("scenario_shock_expired", simulated=True)
                    self._demo_price_multipliers = None
                    self._demo_shock_until = None
            loans = await self.data.list_open_loans()
            results: list[dict[str, object]] = []
            for loan in loans:
                if loan.status.lower() not in {"open", "active", "margin_call"}:
                    continue
                try:
                    price = await self.data.current_price(loan.gpu_id)
                except UpstreamUnavailable as exc:
                    self.events.publish(
                        "keeper_error",
                        loanId=loan.loan_id,
                        reason=str(exc),
                        simulated=loan.simulated or self.settings.mock,
                    )
                    continue
                multiplier = (price_multipliers or {}).get(loan.gpu_id, D(1))
                collateral_value = loan.collateral_shares * price * multiplier
                ltv = loan.outstanding_balance / collateral_value if collateral_value > 0 else D("Infinity")
                state = self._state.setdefault(loan.loan_id, {})
                margin_call_at = loan.margin_call_at or self._read_margin_call_at(state)
                dry_run = self.settings.keeper_dry_run or self.settings.mock or force_dry_run
                immediate_liquidation = ltv >= loan.liquidation_ltv * D("1.25")

                if immediate_liquidation:
                    state_name = "LIQUIDATE"
                    if not state.get("liquidationRequested"):
                        state.setdefault("liquidationAt", _iso(now))
                        state["liquidationRequested"] = await self._action(
                            loan,
                            "liquidate",
                            ltv,
                            loan.liquidation_ltv,
                            "FAR_ABOVE_LIQUIDATION_LTV",
                            now,
                            dry_run,
                            str(state["liquidationAt"]),
                        )
                elif ltv >= loan.margin_call_ltv:
                    if margin_call_at is None:
                        margin_call_at = now
                        state["marginCallAt"] = _iso(now)
                        state["marginCallRequested"] = False
                    else:
                        state.setdefault("marginCallAt", _iso(margin_call_at))
                    if not state.get("marginCallRequested"):
                        state["marginCallRequested"] = await self._action(
                            loan,
                            "margin-call",
                            ltv,
                            loan.margin_call_ltv,
                            "MARGIN_CALL_THRESHOLD_CROSSED",
                            now,
                            dry_run,
                            _iso(margin_call_at),
                        )
                    elapsed = now - margin_call_at
                    if ltv >= loan.liquidation_ltv and elapsed >= timedelta(seconds=self.settings.cure_seconds):
                        state_name = "LIQUIDATE"
                        if not state.get("liquidationRequested"):
                            state.setdefault("liquidationAt", _iso(now))
                            state["liquidationRequested"] = await self._action(
                                loan,
                                "liquidate",
                                ltv,
                                loan.liquidation_ltv,
                                "CURE_WINDOW_EXPIRED_ABOVE_LIQUIDATION_LTV",
                                now,
                                dry_run,
                                str(state["liquidationAt"]),
                            )
                    else:
                        state_name = "MARGIN_CALL"
                else:
                    if margin_call_at is not None:
                        self.events.publish(
                            "margin_call_cured",
                            loanId=loan.loan_id,
                            ltv=ratio6(ltv),
                            reason="LTV_BACK_BELOW_MARGIN_CALL_THRESHOLD",
                            simulated=loan.simulated or self.settings.mock,
                        )
                    if state:
                        state.clear()
                    state_name = "WATCH" if ltv >= loan.margin_call_ltv * D("0.90") else "HEALTHY"

                row = {
                    "loanId": loan.loan_id,
                    "gpuId": loan.gpu_id,
                    "state": state_name,
                    "ltv": ratio6(ltv),
                    "marginCallLtv": ratio6(loan.margin_call_ltv),
                    "liquidationLtv": ratio6(loan.liquidation_ltv),
                    "outstandingBalance": format(loan.outstanding_balance.quantize(D("0.000001")), ".6f"),
                    "collateralValue": format(collateral_value.quantize(D("0.000001")), ".6f"),
                    "simulated": loan.simulated or self.settings.mock or bool(price_multipliers) or demo_shock_active,
                }
                self.events.publish("loan_check", **row, reason=state_name)
                results.append(row)
            self._save_state()
            self._last_health = {
                "checkedAt": _iso(now),
                "loans": results,
                "simulated": self.settings.mock or any(bool(row["simulated"]) for row in results),
            }
            return self._last_health

    def apply_demo_shock(self, multipliers: dict[str, Decimal]) -> datetime:
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=self.settings.demo_shock_seconds)
        self._demo_price_multipliers = multipliers
        self._demo_shock_until = expires_at
        self.events.publish(
            "scenario_shock_started",
            priceMultipliers={key: ratio6(value) for key, value in multipliers.items()},
            expiresAt=_iso(expires_at),
            simulated=True,
        )
        return expires_at

    async def _action(
        self,
        loan: OpenLoan,
        action: str,
        ltv: Decimal,
        threshold: Decimal,
        reason: str,
        now: datetime,
        dry_run: bool,
        idempotency_suffix: str,
    ) -> bool:
        action_path = f"/internal/loans/{quote(loan.loan_id, safe='')}/{action}"
        body: dict[str, object] = {
            "idempotencyKey": f"risk-{action}-{loan.loan_id}-{idempotency_suffix}",
            "observedLtv": ratio6(ltv),
            "threshold": ratio6(threshold),
            "occurredAt": _iso(now),
            "reason": reason,
        }
        try:
            if not dry_run:
                await self.data.submit_action(action_path, body)
            self.events.publish(
                "margin_call" if action == "margin-call" else "liquidation",
                loanId=loan.loan_id,
                ltv=ratio6(ltv),
                threshold=ratio6(threshold),
                reason=reason,
                dryRun=dry_run,
                simulated=loan.simulated or self.settings.mock or dry_run,
            )
            return True
        except UpstreamUnavailable as exc:
            self.events.publish(
                "keeper_error",
                loanId=loan.loan_id,
                reason=str(exc),
                action=action,
                simulated=loan.simulated or self.settings.mock,
            )
            return False

    @staticmethod
    def _read_margin_call_at(state: dict[str, Any]) -> datetime | None:
        value = state.get("marginCallAt")
        if not isinstance(value, str):
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
        except ValueError:
            return None

    async def loop(self) -> None:
        while True:
            try:
                await self.check_once()
            except UpstreamUnavailable as exc:
                self.events.publish("keeper_error", reason=str(exc), simulated=self.settings.mock)
            await asyncio.sleep(self.settings.keeper_interval_seconds)

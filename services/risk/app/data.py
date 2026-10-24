"""Loan and oracle data adapter for mock mode or the internal API."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import httpx

from app.config import Settings
from app.models import OpenLoan


class UpstreamUnavailable(RuntimeError):
    """An API read failed without exposing its URL or response contents."""


MOCK_LOANS: tuple[dict[str, object], ...] = (
    {
        "loanId": "loan-demo-001",
        "borrower": "ALICE",
        "gpuId": "gpu-a",
        "collateralShares": "100.000000",
        "outstandingBalance": "50.000000",
        "marginCallLtv": "0.650000",
        "liquidationLtv": "0.850000",
        "apr": "0.070000",
        "pd": "0.050000",
        "status": "open",
        "simulated": True,
    },
    {
        "loanId": "loan-demo-002",
        "borrower": "BOB",
        "gpuId": "gpu-b",
        "collateralShares": "200.000000",
        "outstandingBalance": "99.000000",
        "marginCallLtv": "0.700000",
        "liquidationLtv": "0.880000",
        "apr": "0.080000",
        "pd": "0.080000",
        "status": "open",
        "simulated": True,
    },
    {
        "loanId": "loan-demo-003",
        "borrower": "CAROL",
        "gpuId": "gpu-a",
        "collateralShares": "100.000000",
        "outstandingBalance": "60.000000",
        "marginCallLtv": "0.720000",
        "liquidationLtv": "0.900000",
        "apr": "0.090000",
        "pd": "0.120000",
        "status": "open",
        "simulated": True,
    },
)
MOCK_PRICES = {"gpu-a": Decimal("1.000000"), "gpu-b": Decimal("0.900000")}


class RiskDataClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._http: httpx.AsyncClient | None = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=8.0)
        return self._http

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def list_open_loans(self) -> list[OpenLoan]:
        if self.settings.mock:
            return [OpenLoan.model_validate(item) for item in MOCK_LOANS]
        if not self.settings.api_url:
            raise UpstreamUnavailable("API_URL_NOT_CONFIGURED")
        payload = await self._get("/internal/loans")
        items = payload if isinstance(payload, list) else payload.get("loans", [])
        if not isinstance(items, list):
            raise UpstreamUnavailable("INVALID_LOAN_RESPONSE")
        try:
            return [OpenLoan.model_validate(item) for item in items]
        except Exception:
            raise UpstreamUnavailable("INVALID_LOAN_RESPONSE") from None

    async def current_price(self, gpu_id: str) -> Decimal:
        if self.settings.mock:
            if gpu_id not in MOCK_PRICES:
                raise UpstreamUnavailable("MOCK_GPU_NOT_FOUND")
            return MOCK_PRICES[gpu_id]
        payload = await self._get(f"/internal/oracle/{gpu_id}/history")
        points: Any = payload
        if isinstance(payload, dict):
            points = payload.get("prices", payload.get("history", []))
        if not isinstance(points, list) or not points:
            raise UpstreamUnavailable("ORACLE_PRICE_UNAVAILABLE")
        try:
            latest = max(points, key=lambda item: item["timestamp"])
            price = Decimal(str(latest["price"]))
            if price <= 0:
                raise ValueError
            return price
        except (KeyError, TypeError, ValueError, ArithmeticError):
            raise UpstreamUnavailable("INVALID_ORACLE_RESPONSE") from None

    async def submit_action(self, path: str, body: dict[str, object]) -> None:
        if self.settings.mock:
            return
        if not self.settings.api_url or not self.settings.internal_api_key:
            raise UpstreamUnavailable("INTERNAL_API_NOT_CONFIGURED")
        await self._post(path, body)

    async def _get(self, path: str) -> Any:
        headers = self._headers()
        try:
            response = await self._client().get(f"{self.settings.api_url}{path}", headers=headers)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError):
            raise UpstreamUnavailable("INTERNAL_API_READ_FAILED") from None

    async def _post(self, path: str, body: dict[str, object]) -> None:
        try:
            response = await self._client().post(
                f"{self.settings.api_url}{path}", json=body, headers=self._headers()
            )
            response.raise_for_status()
        except httpx.HTTPError:
            raise UpstreamUnavailable("INTERNAL_API_ACTION_FAILED") from None

    def _headers(self) -> dict[str, str]:
        if not self.settings.internal_api_key:
            return {}
        return {"X-MS-Internal-Key": self.settings.internal_api_key}

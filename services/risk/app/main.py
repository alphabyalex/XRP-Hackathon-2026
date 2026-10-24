"""Moonshift Risk Desk API. Contract examples live in contracts/risk/."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.config import Settings
from app.book import build_book_stats
from app.data import RiskDataClient, UpstreamUnavailable
from app.events import EventLog
from app.keeper import Keeper
from app.models import QuoteRequest
from app.risk import calculate_quote
from app.models import ScenarioRequest
from app.scenarios import ScenarioDisabled, run_scenario
from app.risk import rate_curve
from app.vault import vault_health


def create_app(
    settings: Settings | None = None,
    data_client: RiskDataClient | None = None,
    event_log: EventLog | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    data_client = data_client or RiskDataClient(settings)
    event_log = event_log or EventLog(settings.state_dir)
    keeper = Keeper(settings, data_client, event_log)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.state_dir.mkdir(parents=True, exist_ok=True)
        task = asyncio.create_task(keeper.loop())
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await data_client.close()

    app = FastAPI(title="Moonshift Risk Desk", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.data_client = data_client
    app.state.events = event_log
    app.state.keeper = keeper

    @app.exception_handler(UpstreamUnavailable)
    async def upstream_error(_: Request, exc: UpstreamUnavailable) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"error": {"code": "UPSTREAM_UNAVAILABLE", "message": str(exc)}},
        )

    def require_internal_key(x_ms_internal_key: str | None) -> None:
        if settings.internal_api_key and x_ms_internal_key != settings.internal_api_key:
            raise HTTPException(status_code=401, detail="bad or missing X-MS-Internal-Key")

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "ok": True,
            "mock": settings.mock,
            "keeperDryRun": settings.keeper_dry_run,
        }

    @app.post("/quote")
    async def quote(
        request: QuoteRequest,
        x_ms_internal_key: str | None = Header(default=None),
    ) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        return calculate_quote(request, settings)

    @app.get("/loans/health")
    async def loans_health(x_ms_internal_key: str | None = Header(default=None)) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        return await keeper.check_once()

    @app.get("/events")
    async def events(x_ms_internal_key: str | None = Header(default=None)) -> StreamingResponse:
        require_internal_key(x_ms_internal_key)
        return StreamingResponse(
            event_log.stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/scenarios/run")
    async def scenarios_run(
        request: ScenarioRequest,
        x_ms_internal_key: str | None = Header(default=None),
    ) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        try:
            return await run_scenario(request, settings, data_client, keeper, event_log)
        except ScenarioDisabled as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from None

    @app.get("/book/stats")
    async def book_stats(
        grade: str | None = None,
        x_ms_internal_key: str | None = Header(default=None),
    ) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        if grade is not None and grade not in {"A", "B", "C", "D", "E"}:
            raise HTTPException(status_code=422, detail="grade must be A, B, C, D, or E")
        return build_book_stats(settings, grade)

    @app.get("/rates/curve")
    async def rates_curve(x_ms_internal_key: str | None = Header(default=None)) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        return rate_curve()

    @app.get("/vault/health")
    async def get_vault_health(x_ms_internal_key: str | None = Header(default=None)) -> dict[str, object]:
        require_internal_key(x_ms_internal_key)
        return await vault_health(settings, data_client)

    return app


app = create_app()


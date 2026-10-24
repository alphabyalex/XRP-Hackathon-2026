"""Moonshift Risk Desk API. Contract examples live in contracts/risk/."""

from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException

from app.config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Moonshift Risk Desk", version="0.1.0")
    app.state.settings = settings

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
    async def quote_stub(x_ms_internal_key: str | None = Header(default=None)) -> dict[str, str]:
        require_internal_key(x_ms_internal_key)
        raise HTTPException(status_code=501, detail="loan quote model is not initialized")

    return app


app = create_app()


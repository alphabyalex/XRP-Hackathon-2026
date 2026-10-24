"""FastAPI application exposing the Moonshift compute contract on port 5000."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .models import BookingRequest, ChatCompletionRequest, ComputeError
from .pricing import RateClient
from .providers import MockProvider, VllmProvider
from .router import ComputeRouter, sse_events
from .scheduler import Scheduler
from .usage import UsageReporter


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    scheduler = Scheduler(settings)
    if settings.mock:
        providers = {
            "gpu-a": MockProvider(settings.mock_latency_seconds),
            "gpu-b": MockProvider(settings.mock_latency_seconds),
        }
    else:
        providers = {"gpu-a": VllmProvider(settings.vllm_url, settings.request_timeout_seconds)}
        providers["gpu-b"] = (
            MockProvider(settings.mock_latency_seconds)
            if settings.gpu_b_mode == "simulated"
            else VllmProvider(settings.gpu_b_vllm_url, settings.request_timeout_seconds)
        )
    router = ComputeRouter(
        settings=settings,
        scheduler=scheduler,
        providers=providers,
        rates=RateClient(
            settings.pricing_url,
            settings.pricing_cache_seconds,
            settings.request_timeout_seconds,
            settings.mock,
        ),
        usage_reporter=UsageReporter(
            settings.api_url, settings.internal_api_key, settings.request_timeout_seconds
        ),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await scheduler.load()
        yield

    app = FastAPI(title="Moonshift Compute", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.scheduler = scheduler
    app.state.router = router

    @app.exception_handler(ComputeError)
    async def compute_error_handler(_: Request, error: ComputeError) -> JSONResponse:
        return JSONResponse(error.body(), status_code=error.status_code)

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "mock": settings.mock}

    @app.get("/gpus")
    async def list_gpus() -> list[dict[str, object]]:
        return await scheduler.list_gpus()

    @app.get("/gpus/{gpu_id}/calendar")
    async def gpu_calendar(
        gpu_id: str,
        from_: datetime | None = Query(default=None, alias="from"),
        to: datetime | None = Query(default=None),
    ) -> list[dict[str, str]]:
        start = from_ or datetime.now(UTC)
        end = to or start + timedelta(hours=24)
        if start.tzinfo is None or end.tzinfo is None:
            raise ComputeError("INVALID_REQUEST", "Calendar times must include UTC offsets.", 400)
        if end <= start:
            raise ComputeError("INVALID_REQUEST", "Calendar 'to' must be after 'from'.", 400)
        return await scheduler.calendar(gpu_id, start, end)

    @app.post("/bookings")
    async def create_booking(
        booking: BookingRequest,
        internal_key: str | None = Header(default=None, alias="X-MS-Internal-Key"),
    ) -> dict[str, str]:
        if internal_key != settings.internal_api_key:
            raise ComputeError("UNAUTHORIZED", "A valid internal API key is required.", 401)
        created = await scheduler.create_booking(booking)
        return {"booking_id": created.booking_id}

    @app.post("/v1/chat/completions")
    async def chat_completions(
        chat: ChatCompletionRequest,
        buyer: str | None = Header(default=None, alias="X-MS-Buyer"),
        booking: str | None = Header(default=None, alias="X-MS-Booking"),
        simulated_demand: str | None = Header(default=None, alias="X-MS-Simulated"),
    ):
        result = await router.chat(
            chat,
            buyer=buyer or "",
            booking=booking,
            simulated_demand=(simulated_demand or "").lower() == "true",
        )
        if chat.stream:
            return StreamingResponse(sse_events(result), media_type="text/event-stream")
        return JSONResponse(result.body)

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("compute.main:app", host="0.0.0.0", port=5000, reload=False)

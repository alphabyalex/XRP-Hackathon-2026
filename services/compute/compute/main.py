"""FastAPI application exposing the Moonshift compute contract on port 5000."""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .models import (
    BookingRequest,
    ChatCompletionRequest,
    ChatMessage,
    ComputeError,
    WorkerRegisterRequest,
)
from .pricing import RateClient
from .providers import ModelProvider, MockProvider, UnavailableProvider, VllmProvider
from .resume import install as install_resume
from .router import ComputeRouter, sse_events
from .scheduler import Scheduler, parse_bucket
from .usage import UsageReporter


def _parse_query_time(val: str | datetime | None, default: datetime) -> datetime:
    if val is None:
        return default
    if isinstance(val, datetime):
        t = val
    else:
        s = str(val).strip().replace(" ", "+").replace("Z", "+00:00")
        try:
            t = datetime.fromisoformat(s)
        except ValueError:
            raise ComputeError("INVALID_REQUEST", f"Cannot parse ISO datetime: {val}", 400) from None
    if t.tzinfo is None:
        raise ComputeError("INVALID_REQUEST", "Times must include a UTC offset.", 400)
    return t.astimezone(UTC)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    scheduler = Scheduler(settings)
    providers: dict[str, ModelProvider] = {}
    configured_endpoints: set[str] = set()

    def provider_for(gid: str) -> ModelProvider:
        if settings.mock:
            return MockProvider(settings.mock_latency_seconds)
        if gid == "gpu-a":
            endpoint = settings.vllm_url
        elif gid == "gpu-b":
            endpoint = settings.gpu_b_vllm_url
        else:
            endpoint = os.getenv(f"{gid.upper().replace('-', '_')}_VLLM_URL", "")
        if not endpoint:
            scheduler.worker(gid).set_offline(True)
            return UnavailableProvider()
        endpoint = endpoint.rstrip("/").removesuffix("/v1")
        if endpoint in configured_endpoints:
            scheduler.worker(gid).set_offline(True)
            return UnavailableProvider()
        configured_endpoints.add(endpoint)
        scheduler.worker(gid).simulated = False
        scheduler.worker(gid).model = settings.canonical_model(gid)
        return VllmProvider(
            endpoint, settings.request_timeout_seconds, settings.wire_model(gid)
        )

    for gid in scheduler.workers:
        providers[gid] = provider_for(gid)
    router = ComputeRouter(
        settings=settings,
        scheduler=scheduler,
        providers=providers,
        rates=RateClient(
            settings.pricing_url,
            settings.pricing_cache_seconds,
            settings.request_timeout_seconds,
            settings.mock,
            api_url=settings.api_url,
            internal_api_key=settings.internal_api_key,
        ),
        usage_reporter=UsageReporter(
            settings.api_url, settings.internal_api_key, settings.request_timeout_seconds
        ),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await scheduler.load()
        yield
        await scheduler.close()

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

    @app.get("/gpus/{gpu_id}/revenue")
    async def gpu_revenue(
        gpu_id: str,
        from_: str | None = Query(default=None, alias="from"),
        to: str | None = Query(default=None),
        bucket: str = Query(default="1h"),
    ) -> list[dict[str, object]]:
        now = datetime.now(UTC)
        end = _parse_query_time(to, now)
        start = _parse_query_time(from_, end - timedelta(hours=24))
        if end <= start:
            raise ComputeError("INVALID_REQUEST", "Revenue 'to' must be after 'from'.", 400)
        bucket_duration = parse_bucket(bucket)
        return await scheduler.revenue(gpu_id, start, end, bucket_duration)

    @app.post("/bookings")
    async def create_booking(
        booking: BookingRequest,
        internal_key: str | None = Header(default=None, alias="X-MS-Internal-Key"),
    ) -> dict[str, str]:
        if internal_key != settings.internal_api_key:
            raise ComputeError("UNAUTHORIZED", "A valid internal API key is required.", 401)
        created = await scheduler.create_booking(booking)
        return {"booking_id": created.booking_id}

    @app.delete("/bookings/{booking_id}")
    async def delete_booking(
        booking_id: str,
        internal_key: str | None = Header(default=None, alias="X-MS-Internal-Key"),
    ) -> dict[str, str]:
        if internal_key != settings.internal_api_key:
            raise ComputeError("UNAUTHORIZED", "A valid internal API key is required.", 401)
        cancelled = await scheduler.cancel_booking(booking_id)
        if not cancelled:
            raise ComputeError("NOT_FOUND", f"Booking {booking_id} not found.", 404)
        return {"status": "cancelled", "booking_id": booking_id}

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

    @app.post("/internal/workers/register")
    async def register_worker(
        req: WorkerRegisterRequest,
        internal_key: str | None = Header(default=None, alias="X-MS-Internal-Key"),
    ) -> dict[str, object]:
        if internal_key != settings.internal_api_key:
            raise ComputeError("UNAUTHORIZED", "A valid internal API key is required.", 401)
        supervisor = scheduler.register_worker(
            gpu_id=req.gpu_id,
            model=req.model,
            tokens_per_sec=req.tokens_per_sec,
            simulated=req.simulated,
        )
        if req.gpu_id not in providers:
            providers[req.gpu_id] = provider_for(req.gpu_id)
        await supervisor.load_snapshot()
        if supervisor.monte_carlo is not None:
            supervisor.monte_carlo.start()
        return {"registered": True, "gpu_id": req.gpu_id, "status": await supervisor.status()}

    @app.get("/monte-carlo/status")
    async def monte_carlo_status() -> dict[str, object]:
        return {gpu_id: worker.monte_carlo.metrics() for gpu_id, worker in scheduler.workers.items()
                if worker.monte_carlo is not None}

    @app.post("/monte-carlo/switch-demo")
    async def monte_carlo_switch_demo(
        gpu_id: str = Query(default="gpu-a"),
        prompt: str = Query(default="Calculate Black-Scholes delta for XRP call"),
    ) -> dict[str, object]:
        worker = scheduler.worker(gpu_id)
        if worker.monte_carlo is None:
            raise ComputeError("FEATURE_UNAVAILABLE", "GPU background risk processing is not available.", 503)
        pre_metrics = worker.monte_carlo.metrics()

        # Measure preemption yield time
        switch_latency_ms = await worker.monte_carlo.preempt(f"DEMO_INSTANT_SWITCH_{gpu_id}")

        # Serve resident LLM inference
        provider = providers[gpu_id]
        inf_start = time.perf_counter()
        completion = await provider.complete(
            messages=[ChatMessage(role="user", content=prompt)],
            model=worker.model,
            max_tokens=64,
            temperature=None,
        )
        inf_latency_ms = round((time.perf_counter() - inf_start) * 1000.0, 2)

        # Resume background Monte Carlo loop
        res_start = time.perf_counter()
        await worker.monte_carlo.resume()
        res_latency_ms = round((time.perf_counter() - res_start) * 1000.0, 2)

        post_metrics = worker.monte_carlo.metrics()
        return {
            "demo": "INSTANT_GPU_WORKLOAD_SWITCH",
            "gpu_id": gpu_id,
            "resident_model": worker.monte_carlo.resident_model,
            "switch_transition": {
                "initial_workload": "MONTE_CARLO_RISK_SIMULATION",
                "preemption_latency_ms": switch_latency_ms,
                "switched_to": "LLM_INFERENCE",
                "inference_completion": completion.content,
                "tokens_generated": completion.output_tokens,
                "inference_latency_ms": inf_latency_ms,
                "restoration_latency_ms": res_latency_ms,
                "final_workload": "MONTE_CARLO_RISK_SIMULATION",
                "total_preempt_and_resume_overhead_ms": round(switch_latency_ms + res_latency_ms, 2),
                "idle_waste_seconds": 0.0,
            },
            "monte_carlo_telemetry": {
                "paths_before_switch": pre_metrics["risk_simulation"]["paths_simulated"],
                "paths_after_resume": post_metrics["risk_simulation"]["paths_simulated"],
                "paths_per_second": post_metrics["risk_simulation"]["throughput_paths_per_sec"],
                "value_at_risk_99": post_metrics["risk_simulation"]["value_at_risk_99"],
            },
        }

    install_resume(app, scheduler, providers, settings, router)  # order router hook (compute/resume.py)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("compute.main:app", host="0.0.0.0", port=5000, reload=False)

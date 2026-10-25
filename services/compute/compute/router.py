"""OpenAI-compatible request routing, metering, and response assembly."""

from __future__ import annotations

import json
import time
import uuid
import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import AsyncIterator

from .config import Settings
from .models import ChatCompletionRequest, ComputeError, UsageEvent
from .pricing import RateCard, RateClient
from .providers import ModelProvider, ProviderError, estimate_text_tokens
from .scheduler import GpuSupervisor, Scheduler
from .usage import UsageReporter


MONEY_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class ChatResult:
    body: dict[str, object]
    x_ms: dict[str, object]


def charge_for(rate: RateCard, input_tokens: int, output_tokens: int) -> Decimal:
    amount = rate.base_fee + (
        Decimal(input_tokens) * rate.input_per_mtok + Decimal(output_tokens) * rate.output_per_mtok
    ) / Decimal("1000000")
    return amount.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


class ComputeRouter:
    def __init__(
        self,
        *,
        settings: Settings,
        scheduler: Scheduler,
        providers: dict[str, ModelProvider],
        rates: RateClient,
        usage_reporter: UsageReporter,
    ) -> None:
        self.settings = settings
        self.scheduler = scheduler
        self.providers = providers
        self.rates = rates
        self.usage_reporter = usage_reporter

    def _estimated_runtime(self, worker: GpuSupervisor, max_tokens: int) -> float:
        return (
            self.settings.prefill_seconds
            + self.settings.network_seconds
            + max_tokens / max(worker.tokens_per_sec, 0.1)
        )

    async def _public_worker(
        self, request_id: str, request: ChatCompletionRequest, max_tokens: int
    ) -> tuple[GpuSupervisor, RateCard, list[dict[str, str]]]:
        wanted_model = request.model or self.settings.model
        input_tokens = sum(estimate_text_tokens(message.content) for message in request.messages)
        candidates: list[tuple[Decimal, float, str, GpuSupervisor, RateCard]] = []
        reasons: list[str] = []
        skipped: list[dict[str, str]] = []
        for worker in self.scheduler.workers.values():
            if wanted_model != worker.model:
                reasons.append("MODEL_MISMATCH")
                skipped.append({"gpu_id": worker.gpu_id, "reason": "MODEL_MISMATCH"})
                continue
            eligibility = await worker.preview_public(self._estimated_runtime(worker, max_tokens))
            if not eligibility.eligible:
                reason = eligibility.reason or "NO_ELIGIBLE_GPU"
                reasons.append(reason)
                skipped.append({"gpu_id": worker.gpu_id, "reason": reason})
                continue
            rate = await self.rates.get(worker.gpu_id)
            status = await worker.status()
            estimated_charge = charge_for(rate, input_tokens, max_tokens)
            candidates.append(
                (
                    estimated_charge,
                    float(status["utilization_pct_1h"]),
                    worker.gpu_id,
                    worker,
                    rate,
                )
            )

        if not candidates:
            if reasons and all(reason == "GPU_BOOKED" for reason in reasons):
                raise ComputeError("GPU_BOOKED", "All matching GPUs are booked right now.", 409)
            if reasons and all(reason in {"GPU_BOOKED", "INSUFFICIENT_RUNWAY"} for reason in reasons):
                raise ComputeError(
                    "INSUFFICIENT_RUNWAY",
                    "No GPU can safely finish this request before its next booking.",
                    409,
                )
            raise ComputeError("NO_ELIGIBLE_GPU", "No healthy GPU can serve this model right now.", 503)

        # Lowest estimated price, then lowest load, then a stable GPU ID tie-break.
        candidates.sort(key=lambda item: (item[0], item[1], item[2]))
        last_error: ComputeError | None = None
        for _, _, _, worker, rate in candidates:
            try:
                await worker.admit_public(request_id, self._estimated_runtime(worker, max_tokens))
                return worker, rate, skipped
            except ComputeError as error:
                # A concurrent request or booking can invalidate a preview. Try
                # the next candidate rather than admitting into a booked window.
                last_error = error
                skipped.append({"gpu_id": worker.gpu_id, "reason": error.code})
        if last_error:
            raise last_error
        raise ComputeError("NO_ELIGIBLE_GPU", "No GPU could accept the request.", 503)

    async def _booked_worker(
        self, request_id: str, buyer: str, booking: str, max_tokens: int
    ) -> tuple[GpuSupervisor, str]:
        worker = await self.scheduler.booking_worker(booking, buyer)
        if not worker:
            raise ComputeError("GPU_BOOKED", "No active booking matches this buyer and redemption.", 409)
        booking_id = await worker.admit_booked(
            request_id, booking, buyer, self._estimated_runtime(worker, max_tokens)
        )
        return worker, booking_id

    async def chat(
        self, request: ChatCompletionRequest, *, buyer: str, booking: str | None, simulated_demand: bool = False
    ) -> ChatResult:
        if not buyer.strip():
            raise ComputeError("INVALID_REQUEST", "X-MS-Buyer is required.", 400)
        public_request = booking is None
        input_estimate = sum(estimate_text_tokens(message.content) for message in request.messages)
        if public_request and input_estimate > self.settings.public_input_token_limit:
            raise ComputeError(
                "INVALID_REQUEST",
                f"Public prompts are limited to {self.settings.public_input_token_limit} input tokens.",
                400,
            )

        requested_max_tokens = request.max_tokens or 128
        max_tokens = min(requested_max_tokens, self.settings.public_max_tokens) if public_request else requested_max_tokens
        request_id = f"req_{uuid.uuid4().hex}"
        booking_id: str | None = None
        if booking:
            worker, booking_id = await self._booked_worker(request_id, buyer, booking, max_tokens)
            rate: RateCard | None = None
            routed_reason = "ACTIVE_BOOKING"
            skipped: list[dict[str, str]] = []
        else:
            worker, rate, skipped = await self._public_worker(request_id, request, max_tokens)
            routed_reason = "LOWEST_ESTIMATED_PRICE"

        started_at = datetime.now(UTC)
        try:
            completion = await asyncio.wait_for(
                self.providers[worker.gpu_id].complete(
                    messages=request.messages,
                    model=worker.model,
                    max_tokens=max_tokens,
                    temperature=request.temperature,
                ),
                timeout=self.settings.request_timeout_seconds,
            )
        except asyncio.TimeoutError as error:
            await worker.release(request_id, succeeded=False)
            raise ComputeError("UPSTREAM_ERROR", "The model request exceeded its runtime timeout.", 503) from error
        except ProviderError as error:
            await worker.release(request_id, succeeded=False)
            raise ComputeError("UPSTREAM_ERROR", "The model endpoint could not complete this request.", 503) from error
        except Exception:
            await worker.release(request_id, succeeded=False)
            raise

        finished_at = datetime.now(UTC)
        await worker.release(request_id, succeeded=True)
        charge = Decimal("0") if booking_id else charge_for(rate or await self.rates.get(worker.gpu_id), completion.input_tokens, completion.output_tokens)
        charge_text = f"{charge.quantize(MONEY_QUANTUM):f}"
        simulated = self.settings.mock or worker.simulated

        event = UsageEvent(
            request_id=request_id,
            gpu_id=worker.gpu_id,
            buyer=buyer,
            booking_id=booking_id,
            input_tokens=completion.input_tokens,
            output_tokens=completion.output_tokens,
            charge=charge_text,
            started_at=started_at,
            finished_at=finished_at,
            simulated=simulated or simulated_demand,
        )
        await self.usage_reporter.report(event)
        await worker.record_usage(event)
        x_ms: dict[str, object] = {
            "request_id": request_id,
            "gpu_id": worker.gpu_id,
            "model": completion.model,
            "input_tokens": completion.input_tokens,
            "output_tokens": completion.output_tokens,
            "charge": charge_text,
            "routed_reason": routed_reason,
            "simulated": simulated,
            "skipped_gpus": skipped,
        }
        body: dict[str, object] = {
            "id": f"chatcmpl_{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": completion.model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": completion.content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": completion.input_tokens,
                "completion_tokens": completion.output_tokens,
                "total_tokens": completion.input_tokens + completion.output_tokens,
            },
            "x_ms": x_ms,
        }
        return ChatResult(body=body, x_ms=x_ms)


async def sse_events(result: ChatResult) -> AsyncIterator[str]:
    """Return OpenAI-shaped SSE plus Moonshift metadata in the final event."""

    body = result.body
    choices = body["choices"]
    assert isinstance(choices, list)
    choice = choices[0]
    assert isinstance(choice, dict)
    message = choice["message"]
    assert isinstance(message, dict)
    chunk = {
        "id": body["id"],
        "object": "chat.completion.chunk",
        "created": body["created"],
        "model": body["model"],
        "choices": [{"index": 0, "delta": message, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(chunk)}\n\n"
    yield f"data: {json.dumps({'object': 'moonshift.metadata', 'x_ms': result.x_ms})}\n\n"
    yield "data: [DONE]\n\n"

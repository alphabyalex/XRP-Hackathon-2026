from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from compute.config import Settings
from compute.models import BookingRequest, ComputeError
from compute.scheduler import Scheduler


def test_booking_blocks_a_public_request_inside_the_guard_window(tmp_path) -> None:
    async def scenario() -> None:
        settings = replace(Settings.from_env(), state_dir=tmp_path)
        scheduler = Scheduler(settings)
        worker = scheduler.worker("gpu-a")
        await worker.add_booking(
            BookingRequest(
                gpu_id="gpu-a",
                slot_start=datetime.now(UTC) + timedelta(seconds=5),
                slots=1,
                redemption_id="redemption-1",
                holder="ALICE",
            )
        )
        eligibility = await worker.preview_public(runtime_seconds=1)
        assert eligibility.eligible is False
        assert eligibility.reason == "INSUFFICIENT_RUNWAY"
        with pytest.raises(ComputeError, match="cannot safely") as error:
            await worker.admit_public("request-1", runtime_seconds=1)
        assert error.value.code == "INSUFFICIENT_RUNWAY"

    asyncio.run(scenario())


def test_worker_drains_before_a_booking_even_when_a_short_request_would_fit(tmp_path) -> None:
    async def scenario() -> None:
        settings = replace(Settings.from_env(), state_dir=tmp_path, drain_lead_seconds=20)
        scheduler = Scheduler(settings)
        worker = scheduler.worker("gpu-a")
        await worker.add_booking(
            BookingRequest(
                gpu_id="gpu-a",
                slot_start=datetime.now(UTC) + timedelta(seconds=15),
                slots=1,
                redemption_id="redemption-drain",
                holder="ALICE",
            )
        )
        status = await worker.status()
        assert status["state"] == "DRAINING"
        eligibility = await worker.preview_public(runtime_seconds=0.1)
        assert eligibility.eligible is False
        assert eligibility.reason == "INSUFFICIENT_RUNWAY"

    asyncio.run(scenario())


def test_active_booking_only_accepts_its_holder_and_recovers_from_snapshot(tmp_path) -> None:
    async def scenario() -> None:
        settings = replace(Settings.from_env(), state_dir=tmp_path)
        scheduler = Scheduler(settings)
        worker = scheduler.worker("gpu-a")
        created = await worker.add_booking(
            BookingRequest(
                gpu_id="gpu-a",
                slot_start=datetime.now(UTC) - timedelta(seconds=1),
                slots=1,
                redemption_id="redemption-2",
                holder="ALICE",
            )
        )
        with pytest.raises(ComputeError) as error:
            await worker.admit_booked("wrong-holder", "redemption-2", "BOB", runtime_seconds=1)
        assert error.value.code == "GPU_BOOKED"

        booking_id = await worker.admit_booked("right-holder", "redemption-2", "ALICE", runtime_seconds=1)
        assert booking_id == created.booking_id
        await worker.release("right-holder", succeeded=True)

        restarted = Scheduler(settings)
        await restarted.load()
        events = await restarted.calendar(
            "gpu-a", datetime.now(UTC) - timedelta(minutes=1), datetime.now(UTC) + timedelta(minutes=1)
        )
        assert any(event["ref"] == "redemption-2" for event in events)

    asyncio.run(scenario())

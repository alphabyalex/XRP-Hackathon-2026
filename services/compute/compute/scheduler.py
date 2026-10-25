"""Per-GPU supervisors, booking calendar, and runway-based admission control."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from .config import Settings
from .models import BookingRequest, ComputeError
from .monte_carlo import MonteCarloRiskEngine


GpuState = Literal["READY", "SERVING", "DRAINING", "BOOKED", "OFFLINE"]
IntervalKind = Literal["BOOKED", "INFERENCE", "HOLD"]


def utc_now() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


def parse_bucket(bucket_str: str) -> timedelta:
    b = bucket_str.strip().lower()
    if b.endswith("h"):
        try:
            return timedelta(hours=float(b[:-1]))
        except ValueError:
            pass
    elif b.endswith("m"):
        try:
            return timedelta(minutes=float(b[:-1]))
        except ValueError:
            pass
    elif b.endswith("d"):
        try:
            return timedelta(days=float(b[:-1]))
        except ValueError:
            pass
    return timedelta(hours=1)


def overlaps(start: datetime, end: datetime, other_start: datetime, other_end: datetime) -> bool:
    return start < other_end and other_start < end


@dataclass(slots=True)
class Booking:
    booking_id: str
    gpu_id: str
    start: datetime
    end: datetime
    redemption_id: str
    holder: str
    kind: IntervalKind = "BOOKED"

    def event(self) -> dict[str, str]:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "kind": self.kind,
            "ref": self.redemption_id,
        }

    def snapshot(self) -> dict[str, str]:
        return {
            "booking_id": self.booking_id,
            "gpu_id": self.gpu_id,
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "redemption_id": self.redemption_id,
            "holder": self.holder,
            "kind": self.kind,
        }

    @classmethod
    def from_snapshot(cls, value: dict[str, str]) -> "Booking":
        return cls(
            booking_id=value["booking_id"],
            gpu_id=value["gpu_id"],
            start=datetime.fromisoformat(value["start"]).astimezone(UTC),
            end=datetime.fromisoformat(value["end"]).astimezone(UTC),
            redemption_id=value["redemption_id"],
            holder=value["holder"],
            kind=value.get("kind", "BOOKED"),  # type: ignore[arg-type]
        )


@dataclass(slots=True)
class Inflight:
    request_id: str
    started_at: datetime
    predicted_end: datetime
    booking_id: str | None


@dataclass(frozen=True, slots=True)
class Eligibility:
    eligible: bool
    reason: str | None = None


class GpuSupervisor:
    """The single authority that controls work reaching one GPU.

    Its lock serializes booking conflict checks and inference admissions. That
    prevents a request from being admitted into the guard window of a new
    booking.
    """

    def __init__(
        self,
        *,
        gpu_id: str,
        model: str,
        simulated: bool,
        tokens_per_sec: float,
        settings: Settings,
        snapshot_path: Path,
    ) -> None:
        self.gpu_id = gpu_id
        self.model = model
        self.simulated = simulated
        self.tokens_per_sec = tokens_per_sec
        self.settings = settings
        self.snapshot_path = snapshot_path
        self._lock = asyncio.Lock()
        self._bookings: list[Booking] = []
        self._inflight: dict[str, Inflight] = {}
        self._history: list[dict[str, object]] = []
        self._offline = False

        # GPU-A runs Qwen2.5-1.5B-Instruct on an NVIDIA T4 with 16 GB VRAM.
        total_vram = 16.0
        model_vram = 3.5
        resident = self.model
        self.monte_carlo = MonteCarloRiskEngine(
            gpu_id=gpu_id,
            resident_model=resident,
            total_vram_gb=total_vram,
            model_vram_gb=model_vram,
            target_paths_per_sec=500_000.0 if "b" in gpu_id.lower() else 250_000.0,
        )

    def set_offline(self, offline: bool) -> None:
        """Order router hook (compute/resume.py): stop admitting work while a provider reclaims the GPU."""
        self._offline = offline

    async def load_snapshot(self) -> None:
        """Restore future bookings after a service restart.

        In-flight requests are deliberately not restored: after a restart the
        upstream vLLM process has no reliable cancellation state. Future and
        currently active booked intervals are restored from disk.
        """

        if not self.snapshot_path.exists():
            return
        try:
            content = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
            bookings = [Booking.from_snapshot(item) for item in content.get("bookings", [])]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError(f"Could not load scheduler snapshot {self.snapshot_path}") from error

        async with self._lock:
            self._bookings = [booking for booking in bookings if booking.end > utc_now()]

    def _persist_unlocked(self) -> None:
        self.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.snapshot_path.with_suffix(".tmp")
        payload = {
            "gpu_id": self.gpu_id,
            "saved_at": utc_now().isoformat(),
            "bookings": [booking.snapshot() for booking in self._bookings],
        }
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.snapshot_path)

    def _active_booking_unlocked(self, now: datetime) -> Booking | None:
        return next(
            (booking for booking in self._bookings if booking.start <= now < booking.end),
            None,
        )

    def _next_blocking_unlocked(self, now: datetime) -> Booking | None:
        upcoming = [booking for booking in self._bookings if booking.start > now]
        return min(upcoming, key=lambda booking: booking.start) if upcoming else None

    def _state_unlocked(self, now: datetime) -> GpuState:
        if self._offline:
            return "OFFLINE"
        if self._active_booking_unlocked(now):
            return "BOOKED"
        next_booking = self._next_blocking_unlocked(now)
        if next_booking and next_booking.start <= now + timedelta(seconds=self.settings.drain_lead_seconds):
            return "DRAINING"
        if self._inflight:
            return "SERVING"
        return "READY"

    def _public_eligibility_unlocked(self, now: datetime, runtime_seconds: float) -> Eligibility:
        if self._offline:
            return Eligibility(False, "OFFLINE")
        if self._active_booking_unlocked(now):
            return Eligibility(False, "GPU_BOOKED")
        if self._inflight:
            return Eligibility(False, "GPU_BUSY")
        next_booking = self._next_blocking_unlocked(now)
        if next_booking:
            # Draining is a hard admission boundary. Existing work can finish,
            # but no new public request starts once the drain window opens.
            if next_booking.start <= now + timedelta(seconds=self.settings.drain_lead_seconds):
                return Eligibility(False, "INSUFFICIENT_RUNWAY")
            required_until = now + timedelta(seconds=runtime_seconds + self.settings.guard_seconds)
            if required_until > next_booking.start:
                return Eligibility(False, "INSUFFICIENT_RUNWAY")
        return Eligibility(True)

    async def preview_public(self, runtime_seconds: float) -> Eligibility:
        async with self._lock:
            return self._public_eligibility_unlocked(utc_now(), runtime_seconds)

    async def admit_public(self, request_id: str, runtime_seconds: float) -> None:
        async with self._lock:
            eligibility = self._public_eligibility_unlocked(utc_now(), runtime_seconds)
            if not eligibility.eligible:
                raise ComputeError(
                    eligibility.reason or "NO_ELIGIBLE_GPU",
                    "This GPU cannot safely serve a public request right now.",
                    409 if eligibility.reason in {"GPU_BOOKED", "INSUFFICIENT_RUNWAY"} else 503,
                )
            now = utc_now()
            self._inflight[request_id] = Inflight(
                request_id=request_id,
                started_at=now,
                predicted_end=now + timedelta(seconds=runtime_seconds),
                booking_id=None,
            )
            await self.monte_carlo.preempt(f"PUBLIC_INFERENCE_{request_id}")

    async def admit_booked(self, request_id: str, redemption_id: str, holder: str, runtime_seconds: float) -> str:
        async with self._lock:
            now = utc_now()
            booking = self._active_booking_unlocked(now)
            if not booking or booking.redemption_id != redemption_id or booking.holder != holder:
                raise ComputeError(
                    "GPU_BOOKED",
                    "The supplied booking is not active for this buyer and GPU slot.",
                    409,
                )
            if self._offline:
                raise ComputeError("NO_ELIGIBLE_GPU", "The booked GPU is offline.", 503)
            if self._inflight:
                raise ComputeError("GPU_BUSY", "The booked GPU is completing another request.", 503)
            self._inflight[request_id] = Inflight(
                request_id=request_id,
                started_at=now,
                predicted_end=now + timedelta(seconds=runtime_seconds),
                booking_id=booking.booking_id,
            )
            await self.monte_carlo.preempt(f"BOOKED_INFERENCE_{booking.booking_id}")
            return booking.booking_id

    async def matching_active_booking(self, redemption_id: str, holder: str) -> bool:
        async with self._lock:
            booking = self._active_booking_unlocked(utc_now())
            return bool(booking and booking.redemption_id == redemption_id and booking.holder == holder)

    async def release(self, request_id: str, *, succeeded: bool) -> Inflight | None:
        async with self._lock:
            inflight = self._inflight.pop(request_id, None)
            if not inflight:
                return None
            if succeeded:
                self._history.append(
                    {
                        "start": inflight.started_at,
                        "end": utc_now(),
                        "kind": "INFERENCE",
                        "ref": request_id,
                    }
                )
                cutoff = utc_now() - timedelta(hours=2)
                self._history = [item for item in self._history if item["end"] >= cutoff]
            self._persist_unlocked()
            if not self._inflight and not self._active_booking_unlocked(utc_now()):
                await self.monte_carlo.resume()
            return inflight

    async def add_booking(self, request: BookingRequest) -> Booking:
        if request.gpu_id != self.gpu_id:
            raise ComputeError("NO_ELIGIBLE_GPU", f"Unknown GPU {request.gpu_id}.", 404)
        start = as_utc(request.slot_start)
        end = start + timedelta(minutes=request.slots * self.settings.slot_minutes)
        async with self._lock:
            now = utc_now()
            if end <= now:
                raise ComputeError("SLOT_TAKEN", "The requested booking slot has already ended.", 409)
            if any(overlaps(start, end, booking.start, booking.end) for booking in self._bookings):
                raise ComputeError("SLOT_TAKEN", "The requested GPU slot is already booked.", 409)
            for inflight in self._inflight.values():
                crosses_start = inflight.predicted_end + timedelta(seconds=self.settings.guard_seconds) > start
                if inflight.started_at < end and crosses_start:
                    raise ComputeError("SLOT_TAKEN", "An admitted request would cross the requested slot.", 409)
            booking = Booking(
                booking_id=f"booking_{uuid.uuid4().hex}",
                gpu_id=self.gpu_id,
                start=start,
                end=end,
                redemption_id=request.redemption_id,
                holder=request.holder,
            )
            self._bookings.append(booking)
            self._bookings.sort(key=lambda item: item.start)
            self._persist_unlocked()
            return booking

    async def cancel_booking(self, booking_id: str) -> bool:
        async with self._lock:
            initial = len(self._bookings)
            self._bookings = [b for b in self._bookings if b.booking_id != booking_id]
            if len(self._bookings) < initial:
                self._persist_unlocked()
                return True
            return False

    async def calendar(self, start: datetime, end: datetime) -> list[dict[str, str]]:
        async with self._lock:
            events: list[dict[str, str]] = [
                booking.event()
                for booking in self._bookings
                if overlaps(booking.start, booking.end, start, end)
            ]
            history = [*self._history]
            history.extend(
                {
                    "start": item.started_at,
                    "end": item.predicted_end,
                    "kind": "INFERENCE",
                    "ref": item.request_id,
                }
                for item in self._inflight.values()
            )
            for item in history:
                interval_start = item["start"]
                interval_end = item["end"]
                if isinstance(interval_start, datetime) and isinstance(interval_end, datetime) and overlaps(
                    interval_start, interval_end, start, end
                ):
                    events.append(
                        {
                            "start": interval_start.isoformat(),
                            "end": interval_end.isoformat(),
                            "kind": str(item["kind"]),
                            "ref": str(item["ref"]),
                        }
                    )
            return sorted(events, key=lambda event: event["start"])

    async def status(self) -> dict[str, object]:
        async with self._lock:
            now = utc_now()
            window_start = now - timedelta(hours=1)
            intervals: list[tuple[datetime, datetime]] = []
            activity = [*self._history]
            activity.extend(
                {
                    "start": booking.start,
                    "end": booking.end,
                    "kind": "BOOKED",
                    "ref": booking.redemption_id,
                }
                for booking in self._bookings
            )
            activity.extend(
                {
                    "start": item.started_at,
                    "end": now,
                    "kind": "INFERENCE",
                    "ref": item.request_id,
                }
                for item in self._inflight.values()
            )
            for item in activity:
                start = max(item["start"], window_start)  # type: ignore[arg-type]
                end = min(item["end"], now)  # type: ignore[arg-type]
                if end > start:
                    intervals.append((start, end))
            intervals.sort(key=lambda interval: interval[0])
            merged: list[list[datetime]] = []
            for start, end in intervals:
                if not merged or start > merged[-1][1]:
                    merged.append([start, end])
                elif end > merged[-1][1]:
                    merged[-1][1] = end
            seconds_busy = sum((end - start).total_seconds() for start, end in merged)
            return {
                "id": self.gpu_id,
                "state": self._state_unlocked(now),
                "model": self.model,
                "simulated": self.simulated,
                "tokens_per_sec": self.tokens_per_sec,
                "utilization_pct_1h": round(min(seconds_busy / 36.0, 100.0), 2),
                "monte_carlo": self.monte_carlo.metrics(),
            }

    async def revenue(
        self, start: datetime, end: datetime, bucket_duration: timedelta
    ) -> list[dict[str, object]]:
        async with self._lock:
            buckets: list[dict[str, object]] = []
            curr = start
            booked_rate_per_min = 4.95 / 60.0
            inf_rate_per_min = 1.80 / 60.0

            while curr < end:
                b_end = min(curr + bucket_duration, end)
                b_total_minutes = max(1.0, (b_end - curr).total_seconds() / 60.0)

                booked_overlap_sec = 0.0
                for booking in self._bookings:
                    o_start = max(curr, booking.start)
                    o_end = min(b_end, booking.end)
                    if o_end > o_start:
                        booked_overlap_sec += (o_end - o_start).total_seconds()

                inf_overlap_sec = 0.0
                all_inf = [*self._history]
                all_inf.extend(
                    {
                        "start": item.started_at,
                        "end": utc_now(),
                    }
                    for item in self._inflight.values()
                )
                for item in all_inf:
                    item_start = item.get("start")
                    item_end = item.get("end")
                    if isinstance(item_start, datetime) and isinstance(item_end, datetime):
                        o_start = max(curr, item_start)
                        o_end = min(b_end, item_end)
                        if o_end > o_start:
                            inf_overlap_sec += (o_end - o_start).total_seconds()

                booked_min = booked_overlap_sec / 60.0
                inf_min = inf_overlap_sec / 60.0
                is_simulated = self.simulated or self.settings.mock

                if booked_min == 0.0 and inf_min == 0.0:
                    h = (int(curr.timestamp()) // 3600) % 24
                    util_pct = 60.0 + (h % 5) * 6.5
                    active_min = b_total_minutes * (util_pct / 100.0)
                    booked_min = active_min * 0.45
                    inf_min = active_min * 0.55
                    is_simulated = True

                idle_min = max(0.0, b_total_minutes - booked_min - inf_min)
                util_pct = min(100.0, ((booked_min + inf_min) / b_total_minutes) * 100.0)
                rev = (booked_min * booked_rate_per_min) + (inf_min * inf_rate_per_min)

                buckets.append(
                    {
                        "start": curr.isoformat(),
                        "end": b_end.isoformat(),
                        "revenue": f"{rev:.6f}",
                        "bookedMinutes": int(round(booked_min)),
                        "inferenceMinutes": int(round(inf_min)),
                        "idleMinutes": int(round(idle_min)),
                        "utilizationPct": f"{util_pct:.6f}",
                        "simulated": is_simulated,
                    }
                )
                curr = b_end

            return buckets


class Scheduler:
    """Container for dynamically scalable GPU supervisors and their persisted calendars."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.workers: dict[str, GpuSupervisor] = {}
        for gid in settings.gpu_nodes:
            self.register_worker(gid)

    def register_worker(
        self,
        gpu_id: str,
        model: str | None = None,
        tokens_per_sec: float | None = None,
        simulated: bool | None = None,
    ) -> GpuSupervisor:
        if gpu_id in self.workers:
            return self.workers[gpu_id]
        sim = (
            simulated
            if simulated is not None
            else (
                self.settings.mock
                if gpu_id == "gpu-a"
                else (self.settings.mock or self.settings.gpu_b_mode == "simulated")
            )
        )
        tps = tokens_per_sec or (
            self.settings.gpu_a_tokens_per_sec if gpu_id == "gpu-a" else self.settings.gpu_b_tokens_per_sec
        )
        supervisor = GpuSupervisor(
            gpu_id=gpu_id,
            model=model or self.settings.model,
            simulated=sim,
            tokens_per_sec=tps,
            settings=self.settings,
            snapshot_path=self.settings.state_dir / f"{gpu_id}-calendar.json",
        )
        self.workers[gpu_id] = supervisor
        return supervisor

    async def load(self) -> None:
        await asyncio.gather(*(worker.load_snapshot() for worker in self.workers.values()))
        for worker in self.workers.values():
            worker.monte_carlo.start()

    async def close(self) -> None:
        await asyncio.gather(*(worker.monte_carlo.stop() for worker in self.workers.values()))

    def worker(self, gpu_id: str) -> GpuSupervisor:
        try:
            return self.workers[gpu_id]
        except KeyError as error:
            raise ComputeError("NO_ELIGIBLE_GPU", f"Unknown GPU {gpu_id}.", 404) from error

    async def list_gpus(self) -> list[dict[str, object]]:
        return [await self.workers[gpu_id].status() for gpu_id in sorted(self.workers)]

    async def calendar(self, gpu_id: str, start: datetime, end: datetime) -> list[dict[str, str]]:
        return await self.worker(gpu_id).calendar(as_utc(start), as_utc(end))

    async def create_booking(self, request: BookingRequest) -> Booking:
        return await self.worker(request.gpu_id).add_booking(request)

    async def cancel_booking(self, booking_id: str) -> bool:
        for worker in self.workers.values():
            if await worker.cancel_booking(booking_id):
                return True
        return False

    async def revenue(
        self, gpu_id: str, start: datetime, end: datetime, bucket_duration: timedelta
    ) -> list[dict[str, object]]:
        return await self.worker(gpu_id).revenue(as_utc(start), as_utc(end), bucket_duration)

    async def booking_worker(self, redemption_id: str, holder: str) -> GpuSupervisor | None:
        for worker in self.workers.values():
            if await worker.matching_active_booking(redemption_id, holder):
                return worker
        return None

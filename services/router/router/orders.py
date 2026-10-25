"""Orders: create (optimize + lease), pay, execute (with resume on reclaim), settle.

Every step works on an order id and the state store, so the same functions run in-process
(ORCHESTRATOR=local) or from the Step Functions step Lambda (router.lambdas.order_step_handler).
"""

from __future__ import annotations

import asyncio
import logging
import math
import secrets
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Any

import httpx

from router import config as C
from router import metrics
from router import optimizer as O
from router import settle as S
from router.catalog import iso, now_utc
from router.engine import GenEvent, Signal, engine_for
from router.errors import RouterError
from router.fleet import FleetEntry
from router.quoting import OrderIn, check_size, spec_dict, to_spec
from router.service import Service
from router.state import LeaseTaken, StateStore

log = logging.getLogger("router.orders")

PERSISTED = {
    "quoted", "paid", "running", "progress", "checkpointed", "moved", "completed", "settled", "failed",
    "paused", "resumed", "capRaised", "cancelled",
}
FINAL = ("settled", "failed", "cancelled")


class Cancelled(Exception):
    """The buyer cancelled (or a pause timed out): stop, settle what was served, refund the rest."""


class OrderCreate(OrderIn):
    mode: str = "balanced"
    buyer: str = C.DEFAULT_BUYER
    # Max price = estimate x (1 + bufferPct / 100); the buyer sets it aside up front.
    bufferPct: int = C.DEFAULT_BUFFER_PCT  # noqa: N815
    taskType: str | None = None  # noqa: N815 (inference batch, fine-tune, render, other)


def unit_price(entry: FleetEntry, kind: str) -> float:
    """USDC per token (inference) or per minute (rental) on this GPU."""
    per_hour = entry.offer.price_per_hour_usdc()
    if kind == "inference":
        return per_hour / 3600.0 / max(entry.offer.tokensPerSec, 1e-9)
    return per_hour / 60.0


class Orders:
    def __init__(self, service: Service, state: StateStore) -> None:
        self.service = service
        self.state = state
        self.cache: dict[str, dict[str, Any]] = {}
        self.subscribers: dict[str, set[asyncio.Queue[tuple[str, dict[str, Any]]]]] = {}
        self.signals: dict[str, dict[tuple[str, int], Signal]] = {}  # gpuId -> {(orderId, part): signal}
        self.compute_transport: httpx.AsyncBaseTransport | None = None
        self.waiters: dict[str, asyncio.Event] = {}  # paused orders wait here for a higher cap or a cancel

    # ---- records and events ----

    def get(self, order_id: str) -> dict[str, Any] | None:
        return self.cache.get(order_id) or self.state.get_order(order_id)

    def save(self, order: dict[str, Any]) -> None:
        self.cache[order["orderId"]] = order
        self.state.put_order(order)

    def emit(self, order: dict[str, Any], kind: str, data: dict[str, Any], persist: bool = True) -> None:
        data = {"orderId": order["orderId"], **data}
        if kind in PERSISTED and persist:
            order.setdefault("events", []).append({"type": kind, "data": data, "at": iso(now_utc())})
            self.save(order)
        for q in list(self.subscribers.get(order["orderId"], ())):
            q.put_nowait((kind, data))

    async def stream(self, order_id: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        order = self.get(order_id)
        if order is None:
            raise RouterError(404, "UNKNOWN_ORDER", f"no order {order_id}")
        q: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()
        self.subscribers.setdefault(order_id, set()).add(q)
        try:
            for ev in order.get("events", []):
                yield ev["type"], ev["data"]
            if order["status"] in FINAL:
                return
            while True:
                try:
                    kind, data = await asyncio.wait_for(q.get(), timeout=C.SSE_PING_SECONDS)
                except TimeoutError:
                    yield "ping", {}
                    continue
                yield kind, data
                if kind in FINAL:
                    return
        finally:
            self.subscribers.get(order_id, set()).discard(q)

    # ---- create ----

    async def create(self, req: OrderCreate) -> dict[str, Any]:
        if req.mode not in O.MODES:
            raise RouterError(422, "INVALID_ORDER", "mode must be cheapest, balanced or fastest")
        if req.bufferPct not in C.BUFFER_CHOICES:
            raise RouterError(422, "INVALID_ORDER", "bufferPct must be 10, 25 or 50")
        if req.kind == "inference" and not isinstance(req.requests, list):
            raise RouterError(422, "INVALID_ORDER", "inference orders need requests: a list of message lists")
        await self.service.state.refresh_compute(self.service.entries, self.compute_transport)
        now = now_utc()
        spec = to_spec(req)
        views = self.service.views(now)
        check_size(spec, views)
        choice = O.choose_for(spec, views)[0][req.mode]  # type: ignore[index]
        if choice.plan is None:
            raise RouterError(409, "NO_FEASIBLE_PLAN", choice.reason or "nothing fits this order")
        order_id = "ord_" + secrets.token_hex(4)
        taken: list[str] = []
        try:
            for part in choice.plan.parts:
                entry = self.service.entry(part.gpu.id)
                assert entry is not None
                self.state.acquire(entry.id, entry.maxConcurrent, order_id, C.LEASE_SECONDS + part.eta_s)
                taken.append(entry.id)
                self.service.state.start_job(entry.id, order_id, now + timedelta(seconds=part.eta_s))
        except LeaseTaken as e:
            for gid in taken:
                self.state.release(gid, order_id)
                self.service.state.end_job(gid, order_id)
            raise RouterError(409, "CAPACITY_TAKEN", f"{e} was taken between quote and order; quote again") from None
        plan = O.plan_dict(choice, spec, now)
        requests = req.requests if isinstance(req.requests, list) else []
        assignments, i = [], 0
        for part in choice.plan.parts:  # contiguous request indices per inference part
            assignments.append(list(range(i, i + part.units)) if spec.kind == "inference" else [])
            i += part.units
        order: dict[str, Any] = {
            "orderId": order_id,
            "kind": spec.kind,
            "mode": req.mode,
            "buyer": req.buyer,
            "status": "created",
            "priceUsdc": plan["priceUsdc"],  # the estimate
            "estimateUsdc": plan["priceUsdc"],
            "bufferPct": req.bufferPct,
            "capUsdc": S.money(float(plan["priceUsdc"]) * (1 + req.bufferPct / 100)),
            "taskType": req.taskType,
            "cancelled": False,
            "pause": None,
            "topUps": [],
            "charged": None,
            "etaSeconds": plan["etaSeconds"],
            "createdAt": iso(now),
            "completesAt": plan["completesAt"],
            "catalogAsOf": self.service.catalog_as_of,
            "plan": plan,
            "requests": requests,
            "maxTokens": req.maxTokens or 256,
            "minutes": spec.total_units * C.SLOT_MINUTES if spec.kind == "rental" else None,
            "assignments": assignments,
            "constraints": spec_dict(spec)["constraints"],
            "payment": None,
            "segments": [],
            "moves": [],
            "progress": {"done": 0, "total": spec.size, "unit": spec.unit, "pct": 0.0},
            "restarts": 0,
            "settlements": [],
            "refund": None,
            "output": [""] * len(requests),
            "events": [],
        }
        if spec.kind == "inference":  # size by what the GPUs will actually be asked for
            order["progress"]["total"] = order["maxTokens"] * len(requests)
        self.save(order)
        metrics.ordered(order_id, req.mode, float(plan["priceUsdc"]))
        self.emit(
            order,
            "quoted",
            {
                "mode": req.mode,
                "priceUsdc": plan["priceUsdc"],
                "etaSeconds": plan["etaSeconds"],
                "gpus": [p["gpuId"] for p in plan["parts"]],
                "providers": plan["providers"],
            },
        )
        return order

    # ---- pay ----

    async def pay(self, order_id: str) -> dict[str, Any]:
        order = self.get(order_id)
        assert order is not None
        if order.get("payment"):
            return order
        try:
            # The cap is set aside on the ledger: provable before any work runs.
            tx = await S.pay(
                order["buyer"],
                S.ORDER_TREASURY,
                order["capUsdc"],
                "MS_ORDER",
                {"orderId": order_id, "mode": order["mode"], "capUsdc": order["capUsdc"]},
            )
        except S.PaymentFailed as e:
            await self.release(order_id)
            order["status"] = "failed"
            self.emit(order, "failed", {"reason": "PAYMENT_FAILED", "detail": str(e)})
            raise RouterError(502, "PAYMENT_FAILED", str(e)) from None
        order["payment"] = {
            "from": order["buyer"],
            "to": S.ORDER_TREASURY,
            "amountUsdc": order["capUsdc"],
            "hash": tx.get("hash"),
            "explorerUrl": S.explorer(tx),
            "validated": tx.get("validated"),
        }
        order["status"] = "paid"
        self.emit(
            order, "paid", {"amountUsdc": order["capUsdc"], "hash": tx.get("hash"), "explorerUrl": S.explorer(tx)}
        )
        return order

    # ---- price cap: pause, raise, cancel ----

    async def _await_budget(self, order: dict[str, Any], needed: float, reason: str) -> None:
        """The cap would be passed: pause until the buyer raises it (or cancels). Never runs over."""
        if order.get("cancelled"):
            raise Cancelled()
        ev = self.waiters.setdefault(order["orderId"], asyncio.Event())
        ev.clear()
        order["status"] = "paused"
        order["pause"] = {
            "reason": reason,
            "spentUsdc": S.money(S.spent(order)),
            "capUsdc": order["capUsdc"],
            "neededUsdc": S.money(needed),
            "at": iso(now_utc()),
        }
        self.emit(order, "paused", dict(order["pause"]))
        try:
            await asyncio.wait_for(ev.wait(), timeout=C.PAUSE_TIMEOUT_SECONDS)
        except TimeoutError:
            order["cancelled"] = True
        if order.get("cancelled"):
            raise Cancelled()
        order["status"] = "running"
        order["pause"] = None
        self.emit(order, "resumed", {"capUsdc": order["capUsdc"]})

    async def raise_cap(self, order_id: str, cap_usdc: float) -> dict[str, Any]:
        """Set aside more (the difference is paid now, MS_ORDER) and let a paused order continue."""
        order = self.get(order_id)
        if order is None:
            raise RouterError(404, "UNKNOWN_ORDER", f"no order {order_id}")
        if order["status"] in FINAL or order["status"] == "completed" or order.get("cancelled"):
            raise RouterError(409, "ORDER_CLOSED", "this order is no longer running")
        old = S.cap(order)
        if not cap_usdc > old:
            raise RouterError(422, "INVALID_CAP", "the new cap must be higher than the current one")
        delta = S.money(cap_usdc - old)
        try:
            tx = await S.pay(
                order["buyer"], S.ORDER_TREASURY, delta, "MS_ORDER",
                {"orderId": order_id, "capUsdc": S.money(cap_usdc), "topUp": True},
            )
        except S.PaymentFailed as e:
            raise RouterError(502, "PAYMENT_FAILED", str(e)) from None
        order["capUsdc"] = S.money(cap_usdc)
        order["topUps"].append({"amountUsdc": delta, "hash": tx.get("hash"), "explorerUrl": S.explorer(tx)})
        self.emit(order, "capRaised", {"capUsdc": order["capUsdc"], "amountUsdc": delta, "hash": tx.get("hash")})
        if ev := self.waiters.get(order_id):
            ev.set()
        return order

    def cancel(self, order_id: str) -> dict[str, Any]:
        """Stop the order: running parts checkpoint and stop; settlement refunds everything not spent."""
        order = self.get(order_id)
        if order is None:
            raise RouterError(404, "UNKNOWN_ORDER", f"no order {order_id}")
        if order["status"] in FINAL or order["status"] == "completed":
            raise RouterError(409, "ORDER_CLOSED", "this order is already finished")
        order["cancelled"] = True
        self.save(order)
        if ev := self.waiters.get(order_id):
            ev.set()
        for sigs in self.signals.values():
            for (oid, _), sig in list(sigs.items()):
                if oid == order_id:
                    sig.fire("CANCELLED", True)
        return order

    def _over_cap(self, order: dict[str, Any], extra: float) -> bool:
        """Would `extra` more cost (the live part of a segment) pass the cap?"""
        return S.spent(order) + extra > S.cap(order) + 1e-9

    async def release(self, order_id: str) -> None:
        order = self.get(order_id)
        if order is None:
            return
        for p in order["plan"]["parts"]:
            self.state.release(p["gpuId"], order_id)
            self.service.state.end_job(p["gpuId"], order_id)
        for seg in order["segments"]:
            self.state.release(seg["gpuId"], order_id)
            self.service.state.end_job(seg["gpuId"], order_id)

    # ---- execute ----

    async def execute(self, order_id: str) -> dict[str, Any]:
        order = self.get(order_id)
        assert order is not None
        order["status"] = "running"
        self.save(order)
        jobs = []
        for idx, part in enumerate(order["plan"]["parts"]):
            entry = self.service.entry(part["gpuId"])
            assert entry is not None
            if order["kind"] == "inference":
                jobs.append(self._run_requests(order, idx, entry, order["assignments"][idx]))
            else:
                jobs.append(self._run_rental(order, idx, entry, float(part["work"])))
        results = await asyncio.gather(*jobs, return_exceptions=True)
        await self.release(order_id)
        self.waiters.pop(order_id, None)
        if order.get("cancelled") or any(isinstance(r, Cancelled) for r in results):
            order["status"] = "cancelled"
            order["pause"] = None
            self.emit(order, "cancelled", {"spentUsdc": S.money(S.spent(order)), "at": iso(now_utc())})
            return order
        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            order["status"] = "failed"
            self.emit(order, "failed", {"reason": "NO_CAPACITY_FOR_REMAINING_WORK", "detail": str(errors[0])[:200]})
            return order
        order["status"] = "completed"
        served: dict[str, float] = {}
        for seg in order["segments"]:
            served[seg["gpuId"]] = served.get(seg["gpuId"], 0) + seg["served"]
        self.emit(
            order,
            "completed",
            {
                "served": [{"gpuId": g, "work": round(w, 3)} for g, w in served.items()],
                "restarts": order["restarts"],
                "at": iso(now_utc()),
            },
        )
        return order

    def _segment(self, order: dict[str, Any], entry: FleetEntry, request: int, reason: str) -> dict[str, Any]:
        seg = {
            "gpuId": entry.id,
            "label": entry.label,
            "provider": entry.offer.provider,
            "pool": entry.moonshiftGpuId,
            "request": request,
            "startedAt": iso(now_utc()),
            "endedAt": None,
            "served": 0.0,
            "unit": "tokens" if order["kind"] == "inference" else "minutes",
            "reason": reason,
            "unitPriceUsdc": f"{self._unit(order, entry):.12f}",
        }
        order["segments"].append(seg)
        return seg

    def _unit(self, order: dict[str, Any], entry: FleetEntry) -> float:
        """USDC per token or minute on this GPU: the order's service-level rate when it has one."""
        rate = order.get("plan", {}).get("rateUsdcPerGpuHour")
        if rate is None:
            return unit_price(entry, order["kind"])
        if order["kind"] == "inference":
            return float(rate) / 3600.0 / max(entry.offer.tokensPerSec, 1e-9)
        return float(rate) / 60.0

    def _register(self, gpu_id: str, order_id: str, key: int) -> Signal:
        sig = Signal()
        self.signals.setdefault(gpu_id, {})[(order_id, key)] = sig
        return sig

    def _unregister(self, gpu_id: str, order_id: str, key: int) -> None:
        self.signals.get(gpu_id, {}).pop((order_id, key), None)

    def _progress(self, order: dict[str, Any], delta: float) -> None:
        p = order["progress"]
        p["done"] = round(p["done"] + delta, 3)
        p["pct"] = round(min(100.0, 100.0 * p["done"] / max(p["total"], 1e-9)), 1)

    async def _next_gpu(self, order: dict[str, Any], current: FleetEntry, spec: O.OrderSpec) -> FleetEntry:
        """Best other GPU (any provider) for the remaining work, in the order's own mode."""
        views = [v for v in self.service.views(now_utc()) if v.id != current.id]
        c = order.get("constraints") or {}
        spec = O.OrderSpec(
            spec.kind,
            tokens=spec.tokens,
            requests=spec.requests,
            minutes=spec.minutes,
            constraints=O.Constraints(c.get("gpuModel"), c.get("region"), tuple(c.get("excludeProviders", ()))),
        )
        # Only a GPU that can finish the rest inside the remaining budget (cap minus what was spent).
        while True:
            budget = max(0.0, S.cap(order) - S.spent(order))
            bounded = O.OrderSpec(
                spec.kind, tokens=spec.tokens, requests=spec.requests, minutes=spec.minutes,
                budgetUsdc=budget, constraints=spec.constraints,
            )
            choice = O.best_for(bounded, order["mode"], views)  # type: ignore[arg-type]
            if choice.plan is None:
                relaxed = O.OrderSpec(spec.kind, tokens=spec.tokens, requests=spec.requests, minutes=spec.minutes, budgetUsdc=budget)
                choice = O.best_for(relaxed, "cheapest", views)
            if choice.plan is not None:
                break
            unbounded = O.best_for(
                O.OrderSpec(spec.kind, tokens=spec.tokens, requests=spec.requests, minutes=spec.minutes), "cheapest", views
            )
            if unbounded.plan is None:
                raise RouterError(503, "NO_CAPACITY", "no GPU can take the remaining work")
            # Something could finish it, just not within the cap: ask the buyer.
            await self._await_budget(order, unbounded.plan.cost - budget, "CAP_REACHED")
            views = [v for v in self.service.views(now_utc()) if v.id != current.id]
        nxt = self.service.entry(choice.plan.parts[0].gpu.id)
        assert nxt is not None
        self.state.acquire(nxt.id, nxt.maxConcurrent, order["orderId"], C.LEASE_SECONDS + choice.plan.eta_s)
        self.service.state.start_job(nxt.id, order["orderId"], now_utc() + timedelta(seconds=choice.plan.eta_s))
        return nxt

    def _moved(
        self, order: dict[str, Any], frm: FleetEntry, to: FleetEntry, reason: str, at_work: float, resume_s: float
    ) -> None:
        move = {
            "at": iso(now_utc()),
            "from": frm.id,
            "to": to.id,
            "fromProvider": frm.offer.provider,
            "toProvider": to.offer.provider,
            "toLabel": to.label,
            "reason": reason,
            "resumedAt": at_work,
            "resumeSeconds": round(resume_s, 2),
        }
        metrics.moved(order["orderId"], reason, resume_s, frm.offer.provider, to.offer.provider)
        order["moves"].append(move)
        self.emit(order, "moved", move)

    async def _run_requests(self, order: dict[str, Any], part: int, entry: FleetEntry, reqs: list[int]) -> None:
        for r in reqs:
            entry = await self._run_one(order, part, entry, r)
        self.service.state.end_job(entry.id, order["orderId"])

    async def _run_one(self, order: dict[str, Any], part: int, entry: FleetEntry, r: int) -> FleetEntry:
        oid, messages, max_tokens = order["orderId"], order["requests"][r], int(order["maxTokens"])
        text, tokens, reason = "", 0, "PLANNED"
        ckpt_key = f"{oid}#{r}"
        if (saved := self.state.get_checkpoint(ckpt_key)) is not None:
            text, tokens = saved["text"], int(saved["tokens"])
        while True:
            seg = self._segment(order, entry, r, reason)
            sig = self._register(entry.id, oid, part)
            self.emit(
                order,
                "running",
                {"gpuId": entry.id, "label": entry.label, "provider": entry.offer.provider, "request": r},
            )
            start_tokens = tokens
            interrupted: GenEvent | None = None
            unit = float(seg["unitPriceUsdc"])
            try:
                async for ev in engine_for(entry).stream(entry, messages, max_tokens, text, tokens, sig):
                    if ev.kind == "token":
                        if self._over_cap(order, (ev.tokens - start_tokens) * unit) and not sig.event.is_set():
                            sig.fire("CAP_REACHED", True)  # checkpoint here; the token past the cap is not kept
                            continue
                        if sig.event.is_set() and sig.reason == "CAP_REACHED":
                            continue
                        text += ev.text
                        tokens = ev.tokens
                        order["output"][r] = text
                        self._progress(order, 1)
                        self.emit(order, "token", {"request": r, "text": ev.text, "index": tokens}, persist=False)
                        if tokens % C.PROGRESS_EVERY_TOKENS == 0:
                            self.emit(order, "progress", dict(order["progress"]), persist=False)
                    elif ev.kind == "checkpoint":
                        self.state.put_checkpoint(
                            ckpt_key, {"text": ev.text, "tokens": ev.tokens, "gpuId": entry.id, "messages": messages}
                        )
                        if ev.reason:
                            self.save(order)
                            self.emit(
                                order, "checkpointed", {"gpuId": entry.id, "done": ev.tokens, "reason": ev.reason}
                            )
                    elif ev.kind == "interrupted":
                        interrupted = ev
                        break
                    elif ev.kind == "done":
                        tokens = ev.tokens
                        text = ev.text or text
                        order["output"][r] = text
            finally:
                self._unregister(entry.id, oid, part)
            seg["served"] = float(tokens - start_tokens)
            seg["endedAt"] = iso(now_utc())
            self.save(order)
            if interrupted is None:
                self.emit(order, "progress", dict(order["progress"]))
                return entry
            if order.get("cancelled") or interrupted.reason == "CANCELLED":
                raise Cancelled()
            if interrupted.reason == "CAP_REACHED":
                # Same GPU, after the buyer raises the cap (or the order is cancelled).
                self.state.put_checkpoint(ckpt_key, {"text": text, "tokens": tokens, "gpuId": entry.id, "messages": messages})
                await self._await_budget(order, max(0.0, (max_tokens - tokens) * unit), "CAP_REACHED")
                reason = "CAP_RAISED"
                continue
            # Resume, don't restart: the next GPU continues from the checkpoint (prompt + partial answer).
            started = asyncio.get_running_loop().time()
            self._note_worker_reclaim(entry, interrupted.reason)
            self.state.release(entry.id, oid)
            self.service.state.end_job(entry.id, oid)
            remaining = max(1, max_tokens - tokens)
            nxt = await self._next_gpu(order, entry, O.OrderSpec("inference", tokens=remaining, requests=1))
            self._moved(
                order,
                entry,
                nxt,
                interrupted.reason or "RECLAIMED",
                tokens,
                asyncio.get_running_loop().time() - started + nxt.offer.startupSeconds,
            )
            entry, reason = nxt, interrupted.reason or "RECLAIMED"

    async def _book_compute(self, order: dict[str, Any], entry: FleetEntry, start: datetime, minutes: float) -> None:
        """Rented time on a GPU services/compute runs: book it through compute's booking route (HRA path)."""
        slot_start = start.replace(second=0, microsecond=0)
        slot_start += timedelta(minutes=(-slot_start.minute) % C.SLOT_MINUTES)
        slots = max(1, math.ceil(minutes / C.SLOT_MINUTES))
        headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
        try:
            async with httpx.AsyncClient(transport=self.compute_transport, timeout=5, headers=headers) as http:
                r = await http.post(
                    f"{C.COMPUTE_URL}/bookings",
                    json={
                        "gpu_id": entry.computeGpuId,
                        "slot_start": iso(slot_start),
                        "slots": slots,
                        "redemption_id": f"{order['orderId']}-{entry.id}",
                        "holder": order["buyer"],
                    },
                )
            if r.status_code < 300:
                return
            log.info("compute booking for %s refused (HTTP %s); booking in the router", entry.id, r.status_code)
        except httpx.HTTPError as e:
            log.info("compute booking for %s unavailable (%s); booking in the router", entry.id, type(e).__name__)
        self.service.state.book(
            entry.id, slot_start, slot_start + timedelta(minutes=slots * C.SLOT_MINUTES), order["orderId"]
        )

    async def _run_rental(self, order: dict[str, Any], part: int, entry: FleetEntry, minutes: float) -> None:
        oid, done, reason = order["orderId"], 0.0, "PLANNED"
        while True:
            start = now_utc()
            # An in-process worker runs rented minutes RENTAL_TIME_SCALE times faster than the clock, so it
            # holds the GPU only for that real time; booking the full rented minutes on the compute calendar
            # left a window no one used that made the next rental on this GPU drain and fail.
            compressed = not entry.endpoint and C.RENTAL_TIME_SCALE > 1
            if entry.computeGpuId and not compressed:
                await self._book_compute(order, entry, start, minutes - done)
            else:
                hold = (minutes - done) / C.RENTAL_TIME_SCALE if compressed else minutes - done
                self.service.state.book(entry.id, start, start + timedelta(minutes=hold), oid)
            seg = self._segment(order, entry, part, reason)
            sig = self._register(entry.id, oid, part)
            self.emit(
                order,
                "running",
                {"gpuId": entry.id, "label": entry.label, "provider": entry.offer.provider, "request": part},
            )
            seg_start = done
            moved_reason = None
            unit = float(seg["unitPriceUsdc"])
            try:
                while done < minutes - 1e-9:
                    step_next = min(C.RENTAL_TIME_SCALE / 60.0, minutes - done)
                    if not sig.event.is_set() and self._over_cap(order, (done - seg_start + step_next) * unit):
                        sig.fire("CAP_REACHED", True)
                    if sig.event.is_set():
                        self.state.put_checkpoint(f"{oid}#rental{part}", {"minutes": done, "gpuId": entry.id})
                        self.emit(
                            order, "checkpointed", {"gpuId": entry.id, "done": round(done, 3), "reason": sig.reason}
                        )
                        if sig.move:
                            moved_reason = sig.reason
                            break
                        sig.clear()
                    await asyncio.sleep(C.RENTAL_TICK_SECONDS)
                    step = min(C.RENTAL_TIME_SCALE / 60.0, minutes - done)  # rented minutes per wall second
                    done += step
                    self._progress(order, step)
                    self.emit(order, "progress", dict(order["progress"]), persist=False)
            finally:
                self._unregister(entry.id, oid, part)
            seg["served"] = round(done - seg_start, 3)
            seg["endedAt"] = iso(now_utc())
            self.save(order)
            if moved_reason is None:
                self.service.state.end_job(entry.id, oid)
                return
            if order.get("cancelled") or moved_reason == "CANCELLED":
                raise Cancelled()
            if moved_reason == "CAP_REACHED":
                await self._await_budget(order, max(0.0, (minutes - done) * unit), "CAP_REACHED")
                reason = "CAP_RAISED"
                continue
            started = asyncio.get_running_loop().time()
            self.state.release(entry.id, oid)
            self.service.state.end_job(entry.id, oid)
            nxt = await self._next_gpu(order, entry, O.OrderSpec("rental", minutes=max(1, math.ceil(minutes - done))))
            self._moved(
                order,
                entry,
                nxt,
                moved_reason,
                round(done, 3),
                asyncio.get_running_loop().time() - started + nxt.offer.startupSeconds,
            )
            entry, reason = nxt, moved_reason

    def _note_worker_reclaim(self, entry: FleetEntry, reason: str) -> None:
        """A worker that saw a provider notice (EC2 IMDS, Azure, GCP) reports it in the stream."""
        if reason in ("RECLAIMED", "CAPACITY_BLOCK_ENDING") and not self.service.state.reclaimed(entry.id, now_utc()):
            self.service.state.reclaim(entry.id, now_utc(), C.DEFAULT_RECLAIM_DURATION_SECONDS, reason)

    def check_drains(self, now: datetime | None = None) -> list[str]:
        """Booking trigger: a booked window about to start on a GPU running our work (compute's drain window)."""
        now = now or now_utc()
        moved: list[str] = []
        for gpu_id, sigs in list(self.signals.items()):
            entry = self.service.entry(gpu_id)
            if entry is None or not sigs or self.service.state.reclaimed(gpu_id, now):
                continue
            running = {oid for oid, _ in sigs}
            for start, end, _ in self.service.state.windows(entry, exclude=running):
                if end > now and (start - now).total_seconds() <= C.BOOKING_DRAIN_SECONDS:
                    moved += self.reclaim(
                        gpu_id,
                        max(0.0, (start - now).total_seconds()),
                        "BOOKING",
                        duration_s=(end - now).total_seconds(),
                    )
                    break
        return sorted(set(moved))

    async def drain_loop(self) -> None:
        while True:
            try:
                await self.service.state.refresh_compute(self.service.entries, self.compute_transport)
                self.check_drains()
            except Exception as e:  # noqa: BLE001 (keep watching)
                log.warning("drain check failed: %s", type(e).__name__)
            await asyncio.sleep(C.DRAIN_CHECK_SECONDS)

    # ---- reclaim ----

    def reclaim(
        self,
        gpu_id: str,
        warning_s: float,
        reason: str,
        move: bool = True,
        duration_s: float = C.DEFAULT_RECLAIM_DURATION_SECONDS,
    ) -> list[str]:
        """One entry point for every trigger: manual, booking drain, AWS/Azure/GCP notices.

        move=False (rebalance recommendation): checkpoint now, keep running. Otherwise the GPU stops
        admitting work immediately and running jobs checkpoint inside the warning window and move.
        """
        if move:
            self.service.state.reclaim(gpu_id, now_utc() + timedelta(seconds=warning_s), duration_s, reason)
        affected = []
        for (order_id, _), sig in list(self.signals.get(gpu_id, {}).items()):
            sig.fire(reason, move)
            affected.append(order_id)
        return sorted(set(affected))

    # ---- settle ----

    async def _report_usage(self, order: dict[str, Any], lines: list[dict[str, Any]]) -> None:
        """apps/api POST /internal/usage, one row per GPU with the work it served and what its pool earned."""
        if C.SETTLEMENT == "off":
            return
        headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
        for line in lines:
            segs = [x for x in order["segments"] if x["gpuId"] == line["gpuId"]]
            body = {
                "request_id": f"{order['orderId']}-{line['gpuId']}",
                "gpu_id": line["pool"],
                "buyer": order["buyer"],
                "booking_id": None,
                "input_tokens": 0,
                "output_tokens": int(line["served"]) if order["kind"] == "inference" else 0,
                "charge": line["toPoolUsdc"],
                "started_at": segs[0]["startedAt"],
                "finished_at": segs[-1]["endedAt"] or iso(now_utc()),
                "simulated": False,
            }
            try:
                async with httpx.AsyncClient(transport=S.TRANSPORT, timeout=5, headers=headers) as http:
                    await http.post(f"{C.API_URL}/internal/usage", json=body)
            except httpx.HTTPError as e:
                log.info("usage report for %s failed: %s", order["orderId"], type(e).__name__)

    async def settle(self, order_id: str) -> dict[str, Any]:
        order = self.get(order_id)
        assert order is not None
        if order["status"] == "settled" or not order.get("payment"):
            return order
        lines = S.settlement_lines(order)
        done_lines = []
        for line in lines:
            entry: dict[str, Any] = {**line}
            if float(line["toPoolUsdc"]) > 0:
                tx = await S.pay(
                    S.ORDER_TREASURY,
                    line["to"],
                    line["toPoolUsdc"],
                    "MS_SETTLE",
                    {"orderId": order_id, "gpuId": line["gpuId"], "tokensOrMinutes": line["served"]},
                )
                entry.update(hash=tx.get("hash"), explorerUrl=S.explorer(tx))
            done_lines.append(entry)
        order["settlements"] = done_lines
        refund = S.refund_amount(order, lines)
        if refund >= 0.000001:
            tx = await S.pay(S.ORDER_TREASURY, order["buyer"], S.money(refund), "MS_REFUND", {"orderId": order_id})
            order["refund"] = {
                "to": order["buyer"],
                "amountUsdc": S.money(refund),
                "hash": tx.get("hash"),
                "explorerUrl": S.explorer(tx),
            }
        order["charged"] = S.money(sum(float(x["amountUsdc"]) for x in lines))
        order["status"] = "cancelled" if order.get("cancelled") else "settled"
        actual = sum(float(x["served"]) * float(x["unitPriceUsdc"]) for x in order["segments"])
        metrics.settled(order_id, order["mode"], float(order["priceUsdc"]), actual)
        await self._report_usage(order, done_lines)
        self.emit(
            order,
            "settled",
            {
                "chargedUsdc": order["charged"],
                "settlements": [
                    {"gpuId": x["gpuId"], "amountUsdc": x["toPoolUsdc"], "hash": x.get("hash")} for x in done_lines
                ],
                "refund": order["refund"],
            },
        )
        return order

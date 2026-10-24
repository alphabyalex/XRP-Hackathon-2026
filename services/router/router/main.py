"""Moonshift order router (FastAPI, port 7200). Contracts: contracts/router/*.json."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from router import config as C
from router import scheduler
from router.catalog import iso, now_utc
from router.dispatch import make_dispatcher
from router.errors import RouterError
from router.orders import OrderCreate, Orders
from router.quoting import OrderIn, quote, to_spec
from router.service import service
from router.state import state_store
from router.store import catalog_store
from router.why import explain

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# Provider keys travel in headers and some query strings; keep client libraries quiet.
for noisy in ("httpx", "botocore", "boto3", "urllib3"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("router")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    store = catalog_store()
    await scheduler.initial_load(service, store)
    collector_task = asyncio.create_task(scheduler.run_forever(service, store))
    app.state.orders = Orders(service, state_store())
    app.state.dispatcher = make_dispatcher(app.state.orders)
    app.state.dispatcher.start()
    log.info(
        "router up: fleet=%s state=%s queue=%s orchestrator=%s offers=%d gpus=%d",
        C.FLEET_SOURCE,
        C.STATE_BACKEND,
        C.QUEUE_BACKEND,
        C.ORCHESTRATOR,
        len(service.offers),
        len(service.entries),
    )
    yield
    collector_task.cancel()
    app.state.dispatcher.stop()


app = FastAPI(title="Moonshift router", version="0.1.0", lifespan=lifespan)


@app.exception_handler(RouterError)
async def router_error(_: Request, exc: RouterError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})


def internal_key(x_ms_internal_key: str | None = Header(default=None)) -> None:
    """Enforced only when INTERNAL_API_KEY is set, so local dev works without it."""
    if C.INTERNAL_API_KEY and x_ms_internal_key != C.INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="bad or missing X-MS-Internal-Key")


class ReclaimRequest(BaseModel):
    warningSeconds: float | None = None  # noqa: N815
    durationSeconds: float = C.DEFAULT_RECLAIM_DURATION_SECONDS  # noqa: N815


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "router",
        "fleetSource": C.FLEET_SOURCE,
        "stateBackend": C.STATE_BACKEND,
        "queueBackend": C.QUEUE_BACKEND,
        "orchestrator": C.ORCHESTRATOR,
        "settlement": C.SETTLEMENT,
        "offers": len(service.offers),
        "gpus": len(service.entries),
        "catalogAsOf": service.catalog_as_of,
        "collectorErrors": sorted(service.errors),
    }


@app.get("/catalog")
def catalog(provider: str | None = None, gpuModel: str | None = None) -> dict:  # noqa: N803
    rows = service.catalog(provider, gpuModel)
    return {"catalogAsOf": service.catalog_as_of, "count": len(rows), "offers": [o.to_dict() for o in rows]}


@app.get("/fleet")
async def fleet() -> list[dict]:
    await service.state.refresh_compute(service.entries)
    now = now_utc()
    return [service.state.describe(e, now) for e in service.entries]


@app.post("/fleet/{gpu_id}/reclaim", dependencies=[Depends(internal_key)])
async def reclaim(gpu_id: str, req: ReclaimRequest) -> dict:
    e = service.entry(gpu_id)
    if e is None:
        raise RouterError(404, "UNKNOWN_GPU", f"no GPU {gpu_id} in the fleet")
    if e.offer.interruptionRatePerHour <= 0 and e.offer.provider != "moonshift":
        raise RouterError(409, "NOT_INTERRUPTIBLE", f"{e.label} is guaranteed capacity")
    warning = e.offer.warningWindowSeconds if req.warningSeconds is None else req.warningSeconds
    affected = app.state.orders.reclaim(gpu_id, warning, "RECLAIMED", duration_s=req.durationSeconds)
    r = service.state.reclaims[gpu_id]
    return {
        "gpuId": gpu_id,
        "label": e.label,
        "warningSeconds": warning,
        "reclaimAt": iso(r.reclaim_at),
        "returnsAt": iso(r.returns_at),
        "affectedOrders": affected,
    }


@app.post("/quote", dependencies=[Depends(internal_key)])
async def post_quote(req: OrderIn) -> dict:
    await service.state.refresh_compute(service.entries)
    now = now_utc()
    spec = to_spec(req)
    alternatives = Counter(o.provider for o in service.catalog())
    body, _ = quote(spec, service.views(now), alternatives, service.catalog_as_of, now)
    body["why"] = explain(body)
    return body


PRIVATE = ("requests", "assignments", "events")


def public(order: dict) -> dict:
    """A copy without prompts and internals. Never mutate the live record (settlement needs unit prices)."""
    out = copy.deepcopy({k: v for k, v in order.items() if k not in PRIVATE})
    for seg in out.get("segments", []):
        seg.pop("unitPriceUsdc", None)
    return out


@app.post("/orders", dependencies=[Depends(internal_key)])
async def post_order(req: OrderCreate) -> dict:
    order = await app.state.orders.create(req)
    order = await app.state.dispatcher.submit(order["orderId"])
    return public(order)


@app.get("/orders", dependencies=[Depends(internal_key)])
def list_orders(limit: int = 20) -> dict:
    return {"orders": [public(o) for o in app.state.orders.state.list_orders(limit)]}


@app.get("/orders/{order_id}", dependencies=[Depends(internal_key)])
def get_order(order_id: str) -> dict:
    order = app.state.orders.get(order_id)
    if order is None:
        raise RouterError(404, "UNKNOWN_ORDER", f"no order {order_id}")
    return public(order)


@app.get("/orders/{order_id}/events")
async def order_events(order_id: str) -> StreamingResponse:
    if app.state.orders.get(order_id) is None:
        raise RouterError(404, "UNKNOWN_ORDER", f"no order {order_id}")

    async def sse():
        async for kind, data in app.state.orders.stream(order_id):
            if kind == "ping":
                yield ": ping\n\n"
            else:
                yield f"event: {kind}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

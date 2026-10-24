"""Moonshift order router (FastAPI, port 7200). Contracts: contracts/router/*.json."""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from router import config as C
from router import scheduler
from router.catalog import iso, now_utc
from router.errors import RouterError
from router.quoting import OrderIn, quote, to_spec
from router.service import service
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
    now = now_utc()
    r = service.state.reclaim(gpu_id, now + timedelta(seconds=warning), req.durationSeconds, "RECLAIMED")
    return {
        "gpuId": gpu_id,
        "label": e.label,
        "warningSeconds": warning,
        "reclaimAt": iso(r.reclaim_at),
        "returnsAt": iso(r.returns_at),
        "affectedOrders": [],
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

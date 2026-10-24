"""Moonshift credit service (FastAPI, port 7100). Contracts: contracts/credit/*.json."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from credit import config as C
from credit import features as F
from credit import mock, portfolio, profile, streams, ws
from credit.errors import CreditError
from credit.events import bus
from credit.link import linker
from credit.monitor import event, monitor
from credit.xrpl_client import AccountNotFound, UpstreamError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# httpx and websockets can log full URLs, and Quicknode URLs carry a token.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("websockets").setLevel(logging.WARNING)
log = logging.getLogger("credit")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    tasks: list[asyncio.Task[None]] = []
    if C.MONITOR_MODE != "off":
        tasks.append(asyncio.create_task(monitor().overdue_loop()))
    if C.MONITOR_MODE == "websocket" and not C.MOCK:
        tasks += ws.start(monitor())
    log.info("credit up: mock=%s monitor=%s quicknode=%s", C.MOCK, C.MONITOR_MODE, C.quicknode_configured())
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Moonshift credit", version="0.1.0", lifespan=lifespan)

CLASSIC_ADDRESS = re.compile(r"^r[1-9A-HJ-NP-Za-km-z]{24,34}$")


@app.exception_handler(CreditError)
async def credit_error(_: Request, exc: CreditError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})


def internal_key(x_ms_internal_key: str | None = Header(default=None)) -> None:
    """Enforced only when INTERNAL_API_KEY is set, so local dev works without it."""
    if C.INTERNAL_API_KEY and x_ms_internal_key != C.INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="bad or missing X-MS-Internal-Key")


def check_target(network: str, address: str) -> None:
    if network not in C.NETWORKS:
        raise CreditError(422, "INVALID_NETWORK", "network must be mainnet, testnet or devnet")
    if not CLASSIC_ADDRESS.match(address):
        raise CreditError(422, "INVALID_ADDRESS", "not a classic XRPL address")


async def build_profile(network: str, address: str, refresh: bool = False) -> dict:
    check_target(network, address)
    if C.MOCK:
        body = mock.profile(network, address)
    else:
        try:
            body, _ = await profile.build(network, address, refresh)
        except AccountNotFound:
            raise CreditError(404, "ACCOUNT_NOT_FOUND", f"{address} does not exist on {network}") from None
        except UpstreamError as e:
            raise CreditError(502, "UPSTREAM_ERROR", str(e)) from None
        body["portfolio"] = await portfolio.context(body["grade"])
    if network == "mainnet":
        body["ownership"] = linker().ownership(address)
    if C.MOCK:
        return body
    bus.publish(
        "profile",
        {k: body[k] for k in ("network", "address", "score", "grade", "confidence", "source", "asOf")},
    )
    return body


# ---- Request bodies ---------------------------------------------------------------------


class Target(BaseModel):
    network: str
    address: str


class BatchRequest(BaseModel):
    items: list[Target] = Field(max_length=C.BATCH_MAX_ITEMS)
    refresh: bool = False


class ChallengeRequest(BaseModel):
    borrower: str
    mainnetAddress: str  # noqa: N815 (contract field name)


class VerifyRequest(BaseModel):
    challengeId: str  # noqa: N815
    publicKey: str  # noqa: N815
    signature: str


class WatchLoan(BaseModel):
    loanId: str  # noqa: N815
    dueAt: str  # noqa: N815
    principal: str | None = None


class WatchRequest(BaseModel):
    network: str
    address: str
    loans: list[WatchLoan] = Field(default_factory=list)


class SimulateRequest(BaseModel):
    network: str
    address: str
    kind: str = "LARGE_OUTFLOW"


# ---- Endpoints -------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "credit",
        "mock": C.MOCK,
        "quicknode": C.quicknode_configured(),
        "monitor": {
            "mode": C.MONITOR_MODE,
            "streamsNetwork": C.STREAMS_NETWORK,
            "streamsTokenSet": bool(C.QUICKNODE_STREAMS_TOKEN),
            "kvSyncEnabled": bool(C.QUICKNODE_API_KEY),
        },
    }


@app.get("/profile/{network}/{address}", dependencies=[Depends(internal_key)])
async def get_profile(network: str, address: str, refresh: bool = False) -> dict:
    return await build_profile(network, address, refresh)


@app.post("/profiles", dependencies=[Depends(internal_key)])
async def post_profiles(req: BatchRequest) -> dict:
    profiles, errors = [], []
    for item in req.items:
        try:
            profiles.append(await build_profile(item.network, item.address, req.refresh))
        except CreditError as e:
            errors.append(
                {"network": item.network, "address": item.address, "code": e.code, "message": e.message}
            )
    return {"profiles": profiles, "errors": errors}


@app.post("/link/challenge", dependencies=[Depends(internal_key)])
def link_challenge(req: ChallengeRequest) -> dict:
    for addr in (req.borrower, req.mainnetAddress):
        if not CLASSIC_ADDRESS.match(addr):
            raise CreditError(422, "INVALID_ADDRESS", f"{addr} is not a classic XRPL address")
    return linker().challenge(req.borrower, req.mainnetAddress, datetime.now(UTC))


@app.post("/link/verify", dependencies=[Depends(internal_key)])
async def link_verify(req: VerifyRequest) -> dict:
    try:
        return await linker().verify(req.challengeId, req.publicKey, req.signature, datetime.now(UTC))
    except AccountNotFound:
        raise CreditError(422, "KEY_ADDRESS_MISMATCH", "mainnet account not found") from None
    except UpstreamError as e:
        raise CreditError(502, "UPSTREAM_ERROR", str(e)) from None


@app.get("/links/{borrower}", dependencies=[Depends(internal_key)])
def links(borrower: str) -> dict:
    return {"borrower": borrower, "mainnet": linker().links_for(borrower)}


@app.post("/watch", dependencies=[Depends(internal_key)])
async def watch(req: WatchRequest) -> dict:
    check_target(req.network, req.address)
    loans = [lo.model_dump() for lo in req.loans]
    if not C.MOCK:
        # Also track loans already visible on-ledger, so MISSED_PAYMENT works for them too.
        try:
            _, hist = await profile.build(req.network, req.address)
            known = {lo["loanId"] for lo in loans}
            loans += [lo for lo in F.open_loans(hist) if lo["loanId"] not in known]
        except (AccountNotFound, UpstreamError) as e:
            log.info("watch %s: no history loaded (%s)", req.address, type(e).__name__)
    monitor().add(req.network, req.address, loans, datetime.now(UTC))
    kv_synced = await streams.kv_add(req.address) if C.MONITOR_MODE == "streams" else False
    return {
        "network": req.network,
        "address": req.address,
        "watching": True,
        "mode": C.MONITOR_MODE,
        "kvSynced": kv_synced,
    }


@app.delete("/watch/{network}/{address}", dependencies=[Depends(internal_key)])
async def unwatch(network: str, address: str) -> dict:
    check_target(network, address)
    monitor().remove(network, address)
    if C.MONITOR_MODE == "streams" and not monitor().watched_anywhere(address):
        await streams.kv_remove(address)
    return {"network": network, "address": address, "watching": False}


@app.get("/watch", dependencies=[Depends(internal_key)])
def watch_list() -> dict:
    return {"mode": C.MONITOR_MODE, "watched": monitor().watched()}


@app.post("/streams/xrpl")
async def streams_webhook(request: Request) -> dict:
    """Quicknode Streams destination. Authenticated by the X-QN-Signature HMAC, not the internal key."""
    raw = await request.body()
    try:
        payload = streams.decode_body(raw, request.headers.get("content-encoding"))
    except OSError:
        raise CreditError(400, "BAD_BODY", "could not decompress body") from None
    signed = streams.verify_signature(
        C.QUICKNODE_STREAMS_TOKEN,
        request.headers.get("x-qn-nonce", ""),
        request.headers.get("x-qn-timestamp", ""),
        payload,
        request.headers.get("x-qn-signature", ""),
    )
    if not signed and not C.STREAMS_ALLOW_UNSIGNED:
        raise CreditError(401, "BAD_SIGNATURE", "missing or invalid X-QN-Signature")
    try:
        body = json.loads(payload) if payload.strip() else {}
    except json.JSONDecodeError:
        raise CreditError(400, "BAD_BODY", "body is not JSON") from None
    received, emitted = 0, 0
    for network, t, addresses in streams.iter_txs(body):
        received += 1
        emitted += len(monitor().handle_tx(network, t, "streams", addresses))
    return {"ok": True, "received": received, "events": emitted}


@app.post("/monitor/simulate", dependencies=[Depends(internal_key)])
async def monitor_simulate(req: SimulateRequest) -> dict:
    """Demo helper: emit a credit event that did not happen on-ledger. Always labeled simulated."""
    check_target(req.network, req.address)
    severity = {"MISSED_PAYMENT": "critical", "LIQUIDATION": "critical", "MS_REPAY": "info"}.get(
        req.kind, "warn"
    )
    now = datetime.now(UTC)
    ev = event(
        req.kind,
        severity,
        req.network,
        req.address,
        None,
        f"Simulated {req.kind} for the demo",
        "simulated",
        at=now,
        simulated=True,
    )
    ev["id"] = ev["id"] + now.strftime("%H%M%S%f")[:8]
    monitor().emit(ev)
    return ev


@app.get("/events")
async def events() -> StreamingResponse:
    return StreamingResponse(
        bus.stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )

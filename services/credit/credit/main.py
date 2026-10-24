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
from credit import combine, explain, live, mock, portfolio, profile, stats, streams, ws
from credit import features as F
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
    monitor().on_tx = rescorer().on_tx
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


async def build_profile(
    network: str, address: str, refresh: bool = False, combined: bool = True, refresh_link: bool = False
) -> dict:
    check_target(network, address)
    link = linker().link_for(address) if (combined and network != "mainnet" and not C.MOCK) else None
    # A connected wallet replaces the configured history; that history stays as a reference line.
    wallet = linker().wallet_for(address) if (combined and network != "mainnet" and not C.MOCK) else None
    if C.MOCK:
        body = mock.profile(network, address)
    else:
        try:
            if wallet:
                own = {"verified": wallet["verified"], "status": wallet["status"], "borrower": address}
                with_wallet = await combine.build(
                    network,
                    address,
                    {"network": wallet["network"], "address": wallet["address"], "ownership": own},
                    refresh,
                    reference=link,
                    refresh_link=refresh_link,
                )
                # The wallet is blended in by its confidence, on top of the borrower's own profile.
                if link:
                    base = await combine.build(network, address, link, refresh)
                else:
                    base, _ = await profile.build(network, address, refresh)
                connect_score = wallet["connectScore"]
                if connect_score is None:
                    connect_score = with_wallet["score"]
                    linker().set_connect_score(address, connect_score)
                body = combine.blend(base, with_wallet, connect_score)
            elif link:
                body = await combine.build(network, address, link, refresh)
            else:
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
    if wallet:
        rescorer().remember(address, body)
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
    mainnetAddress: str = ""  # noqa: N815 (contract field name); the address to prove, if known
    network: str = "mainnet"  # "testnet": connect a wallet (Crossmark sign-in)


class VerifyRequest(BaseModel):
    challengeId: str  # noqa: N815
    publicKey: str  # noqa: N815
    signature: str
    address: str | None = None  # the wallet's address as it reported it (RegularKey accounts)


class WalletRequest(BaseModel):
    borrower: str
    address: str
    network: str = "testnet"


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


@app.get("/stats")
def get_stats() -> dict:
    """Upstream XRPL reads since start: calls by source, network and method, Quicknode credits,
    cache hit rate, p50 latency. Counts only, no URLs (contracts/credit/stats.json)."""
    out = stats.snapshot()
    out["quicknodeConfigured"] = C.quicknode_configured()
    out["mock"] = C.MOCK
    return out


@app.get("/profile/{network}/{address}", dependencies=[Depends(internal_key)])
async def get_profile(network: str, address: str, refresh: bool = False, combined: bool = True) -> dict:
    """With a linked mainnet address (verified, or a labeled demo link), devnet and testnet
    profiles combine the borrower's Moonshift history with the linked payment history."""
    return await build_profile(network, address, refresh, combined)


@app.get("/explain/{network}/{address}", dependencies=[Depends(internal_key)])
async def get_explain(network: str, address: str, refresh: bool = False) -> dict:
    if C.MOCK:
        check_target(network, address)
        return mock.explain(network, address)
    return explain.factors(await build_profile(network, address, refresh))


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


WALLET_NETWORKS = ("testnet",)


@app.post("/link/challenge", dependencies=[Depends(internal_key)])
def link_challenge(req: ChallengeRequest) -> dict:
    if req.network != "mainnet" and req.network not in WALLET_NETWORKS:
        raise CreditError(422, "INVALID_NETWORK", "network must be mainnet or testnet")
    addrs = [req.borrower] + ([req.mainnetAddress] if req.mainnetAddress or req.network == "mainnet" else [])
    for addr in addrs:
        if not CLASSIC_ADDRESS.match(addr):
            raise CreditError(422, "INVALID_ADDRESS", f"{addr} is not a classic XRPL address")
    return linker().challenge(req.borrower, req.mainnetAddress, datetime.now(UTC), req.network)


@app.post("/link/verify", dependencies=[Depends(internal_key)])
async def link_verify(req: VerifyRequest) -> dict:
    try:
        out = await linker().verify(req.challengeId, req.publicKey, req.signature, datetime.now(UTC), address=req.address)
    except AccountNotFound:
        raise CreditError(422, "KEY_ADDRESS_MISMATCH", "account not found") from None
    except UpstreamError as e:
        raise CreditError(502, "UPSTREAM_ERROR", str(e)) from None
    if out.get("network") in WALLET_NETWORKS:
        await wallet_connected(out)
    return out


@app.post("/link/wallet", dependencies=[Depends(internal_key)])
async def link_wallet(req: WalletRequest) -> dict:
    """Connect a wallet by pasting its address: read-only, ownership not verified."""
    if req.network not in WALLET_NETWORKS:
        raise CreditError(422, "INVALID_NETWORK", "network must be testnet")
    for addr in (req.borrower, req.address):
        if not CLASSIC_ADDRESS.match(addr):
            raise CreditError(422, "INVALID_ADDRESS", f"{addr} is not a classic XRPL address")
    out = linker().connect_wallet(req.borrower, req.network, req.address, datetime.now(UTC))
    await wallet_connected(out)
    return out


@app.get("/link/wallet/{borrower}", dependencies=[Depends(internal_key)])
async def get_wallet(borrower: str) -> dict:
    """The connected wallet and its newest transactions (the activity feed's first lines)."""
    w = linker().wallet_for(borrower)
    recent: list[dict] = []
    if w and not C.MOCK:
        try:
            recent = await live.recent_activity(w["network"], w["address"])
        except (AccountNotFound, UpstreamError):
            recent = []
    return {"borrower": borrower, "wallet": w, "activity": recent}


@app.delete("/link/wallet/{borrower}", dependencies=[Depends(internal_key)])
def delete_wallet(borrower: str) -> dict:
    w = linker().disconnect_wallet(borrower)
    if w and not linker().borrowers_for_wallet(w["network"], w["address"]):
        monitor().remove(w["network"], w["address"])
    return {"borrower": borrower, "wallet": None}


async def wallet_connected(w: dict) -> None:
    """Watch the wallet live (Quicknode WebSocket) and score it now, so the first live change has
    a profile to compare against."""
    monitor().add(w["network"], w["address"], [], datetime.now(UTC))
    log.info("wallet connected: %s on %s (%s)", w["address"], w["network"], w["status"])
    try:
        await build_profile(live.BORROWER_NETWORK, w["borrower"], refresh_link=True)
    except CreditError as e:
        log.info("first score for %s failed: %s", w["address"], e.code)


_rescorer: live.Rescorer | None = None


def rescorer() -> live.Rescorer:
    global _rescorer
    if _rescorer is None:
        _rescorer = live.Rescorer(monitor(), build_profile)
    return _rescorer


class DemoLinkRequest(BaseModel):
    borrower: str
    mainnetAddress: str  # noqa: N815


@app.post("/link/demo", dependencies=[Depends(internal_key)])
def link_demo(req: DemoLinkRequest) -> dict:
    """Attach a mainnet history address without a signature, for the demo. Labeled unverified."""
    for addr in (req.borrower, req.mainnetAddress):
        if not CLASSIC_ADDRESS.match(addr):
            raise CreditError(422, "INVALID_ADDRESS", f"{addr} is not a classic XRPL address")
    return linker().demo_link(req.borrower, req.mainnetAddress, datetime.now(UTC))


@app.get("/links/{borrower}", dependencies=[Depends(internal_key)])
def links(borrower: str) -> dict:
    return {"borrower": borrower, "mainnet": linker().links_for(borrower), "combinedWith": linker().link_for(borrower)}


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
    now = datetime.now(UTC)
    monitor().add(req.network, req.address, loans, now)
    feeds = [{"network": req.network, "address": req.address, "source": C.ws_endpoint(req.network)[1]}]
    # A linked mainnet history is watched too, through Quicknode's WebSocket when configured.
    link = linker().link_for(req.address) if req.network != "mainnet" else None
    if link:
        monitor().add("mainnet", link["mainnetAddress"], [], now)
        feeds.append({"network": "mainnet", "address": link["mainnetAddress"], "source": C.ws_endpoint("mainnet")[1], "ownership": link["ownership"]["status"]})
    kv_synced = await streams.kv_add(req.address) if C.MONITOR_MODE == "streams" else False
    return {
        "network": req.network,
        "address": req.address,
        "watching": True,
        "mode": C.MONITOR_MODE,
        "feeds": feeds,
        "kvSynced": kv_synced,
    }


@app.delete("/watch/{network}/{address}", dependencies=[Depends(internal_key)])
async def unwatch(network: str, address: str) -> dict:
    check_target(network, address)
    monitor().remove(network, address)
    link = linker().link_for(address) if network != "mainnet" else None
    if link:
        monitor().remove("mainnet", link["mainnetAddress"])
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

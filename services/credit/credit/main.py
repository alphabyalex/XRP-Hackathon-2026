"""Moonshift credit service (FastAPI, port 7100). Contracts: contracts/credit/*.json."""

from __future__ import annotations

import logging
import re

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from credit import config as C
from credit import mock
from credit.events import bus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# httpx logs full request URLs at INFO, and Quicknode URLs carry a token.
logging.getLogger("httpx").setLevel(logging.WARNING)

app = FastAPI(title="Moonshift credit", version="0.1.0")

CLASSIC_ADDRESS = re.compile(r"^r[1-9A-HJ-NP-Za-km-z]{24,34}$")


class CreditError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


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
        return mock.profile(network, address)
    raise CreditError(503, "NOT_IMPLEMENTED", "live scoring lands in Phase 2 and 3; run with MOCK=1")


# ---- Request bodies ---------------------------------------------------------------------


class Target(BaseModel):
    network: str
    address: str


class BatchRequest(BaseModel):
    items: list[Target] = Field(max_length=C.BATCH_MAX_ITEMS)
    refresh: bool = False


# ---- Endpoints -------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "credit", "mock": C.MOCK, "quicknode": C.quicknode_configured()}


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


@app.get("/events")
async def events() -> StreamingResponse:
    return StreamingResponse(
        bus.stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )

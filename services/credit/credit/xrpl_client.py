"""Read-only XRPL JSON-RPC client (Quicknode first, public fallback), with SQLite cache and backoff.

This module only ever calls read methods. There is no submit path, so it cannot send a transaction
on any network, mainnet included. Error messages never include the endpoint URL (it holds a token).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

from credit import config as C
from credit import stats
from credit.db import Store, store

log = logging.getLogger("credit.xrpl")

READ_METHODS = frozenset(
    {"account_info", "account_lines", "account_objects", "account_offers", "account_tx", "ledger", "server_info"}
)
RATE_LIMIT_ERRORS = frozenset({"slowDown", "tooBusy"})
RETRY_STATUS = frozenset({429, 502, 503, 504})


_last_call: dict[tuple[str, str], float] = {}


async def _pace(network: str, source: str) -> None:
    """Space upstream calls: Quicknode free plan allows 15 rps, public servers throttle much sooner."""
    gap = C.QUICKNODE_MIN_INTERVAL_SECONDS if source == "quicknode" else C.PUBLIC_MIN_INTERVAL_SECONDS
    loop = asyncio.get_running_loop()
    wait = _last_call.get((network, source), 0.0) + gap - loop.time()
    if wait > 0:
        await asyncio.sleep(wait)
    _last_call[(network, source)] = loop.time()


class AccountNotFound(Exception):
    pass


class UpstreamError(Exception):
    pass


@dataclass
class TxPage:
    transactions: list[dict[str, Any]]
    pages: int
    truncated: bool


@dataclass
class XrplClient:
    network: str
    transport: httpx.AsyncBaseTransport | None = None  # tests inject httpx.MockTransport
    db: Store = field(default_factory=store)
    calls: int = 0  # upstream calls actually made (cache misses), for tests and logs

    def __post_init__(self) -> None:
        self.url, self.source = C.endpoint(self.network)

    async def rpc(
        self,
        method: str,
        params: dict[str, Any],
        *,
        ttl: float | None = C.CACHE_TTL_SECONDS,
        refresh: bool = False,
    ) -> dict[str, Any]:
        if method not in READ_METHODS:
            raise ValueError(f"{method} is not an allowed read method")
        key = hashlib.sha256(
            json.dumps([self.network, self.source, method, params], sort_keys=True).encode()
        ).hexdigest()
        if not refresh:
            hit = self.db.cache_get(key, ttl)
            if hit is not None:
                stats.record_hit(self.network, self.source)
                return hit
        result = await self._call(method, params)
        self.db.cache_put(key, self.network, self.source, method, params, result)
        return result

    async def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        body = {"method": method, "params": [params]}
        last = "no attempt"
        async with httpx.AsyncClient(transport=self.transport, timeout=C.HTTP_TIMEOUT_SECONDS) as http:
            for attempt in range(C.RETRY_ATTEMPTS):
                delay = C.RETRY_BASE_SECONDS * (2**attempt)
                await _pace(self.network, self.source)
                try:
                    self.calls += 1
                    with stats.Timer() as timer:
                        r = await http.post(self.url, json=body)
                    stats.record_call(self.network, self.source, method, timer.ms, r.status_code < 400)
                except httpx.HTTPError as e:
                    stats.record_call(self.network, self.source, method, 0.0, False)
                    last = type(e).__name__
                else:
                    if r.status_code in RETRY_STATUS:
                        last = f"HTTP {r.status_code}"
                        retry_after = r.headers.get("retry-after", "")
                        if retry_after.isdigit():
                            delay = max(delay, float(retry_after))
                    elif r.status_code >= 400:
                        raise UpstreamError(f"{self.network} {method}: HTTP {r.status_code}")
                    else:
                        result = r.json().get("result", {})
                        err = result.get("error")
                        if err in RATE_LIMIT_ERRORS:
                            last = err
                        elif err == "actNotFound":
                            raise AccountNotFound(params.get("account", ""))
                        elif err:
                            raise UpstreamError(f"{self.network} {method}: {err}")
                        else:
                            return dict(result)
                log.warning(
                    "%s %s via %s: %s, retry %d in %.1fs",
                    self.network,
                    method,
                    self.source,
                    last,
                    attempt + 1,
                    delay,
                )
                await asyncio.sleep(delay)
        raise UpstreamError(f"{self.network} {method}: {last} after {C.RETRY_ATTEMPTS} attempts")

    # ---- the three reads the scorecard needs ----

    async def account_info(self, address: str, refresh: bool = False) -> dict[str, Any]:
        return await self.rpc(
            "account_info", {"account": address, "ledger_index": "validated"}, refresh=refresh
        )

    async def account_lines(
        self, address: str, refresh: bool = False, max_pages: int = 5
    ) -> list[dict[str, Any]]:
        lines: list[dict[str, Any]] = []
        marker: Any = None
        for _ in range(max_pages):
            params: dict[str, Any] = {"account": address, "ledger_index": "validated", "limit": 400}
            if marker is not None:
                params["marker"] = marker
            res = await self.rpc("account_lines", params, refresh=refresh)
            lines.extend(res.get("lines", []))
            marker = res.get("marker")
            if marker is None:
                break
        return lines

    async def account_tx(self, address: str, refresh: bool = False) -> TxPage:
        """Newest first, following the marker up to ACCOUNT_TX_MAX_PAGES pages."""
        txs: list[dict[str, Any]] = []
        marker: Any = None
        pages = 0
        while pages < C.ACCOUNT_TX_MAX_PAGES:
            params: dict[str, Any] = {
                "account": address,
                "ledger_index_min": -1,
                "ledger_index_max": -1,
                "limit": C.ACCOUNT_TX_PAGE_LIMIT,
                "forward": False,
            }
            if marker is not None:
                params["marker"] = marker
            # Pages after the first are addressed by marker and never change, so they cache forever.
            ttl = C.CACHE_TTL_SECONDS if marker is None else None
            res = await self.rpc("account_tx", params, ttl=ttl, refresh=refresh and marker is None)
            pages += 1
            txs.extend(res.get("transactions", []))
            marker = res.get("marker")
            if marker is None:
                return TxPage(txs, pages, False)
        return TxPage(txs, pages, True)

    async def account_objects(self, address: str, refresh: bool = False, max_pages: int = 3) -> list[dict[str, Any]]:
        """Ledger objects the account owns: escrows (locked collateral), loans, offers, checks, channels."""
        objs: list[dict[str, Any]] = []
        marker: Any = None
        for _ in range(max_pages):
            params: dict[str, Any] = {"account": address, "ledger_index": "validated", "limit": 200}
            if marker is not None:
                params["marker"] = marker
            res = await self.rpc("account_objects", params, refresh=refresh)
            objs.extend(res.get("account_objects", []))
            marker = res.get("marker")
            if marker is None:
                break
        return objs

    async def account_offers(self, address: str, refresh: bool = False) -> list[dict[str, Any]]:
        """Open orders on the DEX: balance the account has committed but not spent."""
        res = await self.rpc("account_offers", {"account": address, "ledger_index": "validated", "limit": 200}, refresh=refresh)
        return list(res.get("offers", []))

    async def server_info(self) -> dict[str, Any]:
        """Network status (validated ledger, fees, load). Never cached: it is the live view."""
        res = await self.rpc("server_info", {}, refresh=True)
        return dict(res.get("info", {}))

    async def first_tx(self, address: str) -> dict[str, Any] | None:
        """Oldest transaction of the account (the payment that funded it). Immutable, cached forever."""
        params = {
            "account": address,
            "ledger_index_min": -1,
            "ledger_index_max": -1,
            "limit": 1,
            "forward": True,
        }
        res = await self.rpc("account_tx", params, ttl=None)
        txs = res.get("transactions", [])
        return txs[0] if txs else None

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
from credit.db import Store, store

log = logging.getLogger("credit.xrpl")

READ_METHODS = frozenset({"account_info", "account_lines", "account_tx", "ledger", "server_info"})
RATE_LIMIT_ERRORS = frozenset({"slowDown", "tooBusy"})
RETRY_STATUS = frozenset({429, 502, 503, 504})


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
                try:
                    self.calls += 1
                    r = await http.post(self.url, json=body)
                except httpx.HTTPError as e:
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

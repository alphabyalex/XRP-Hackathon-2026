"""Quicknode Streams: signed webhook receiver and Key-Value Store watchlist sync.

Stream setup (Quicknode dashboard): chain XRP Ledger, network = STREAMS_NETWORK, dataset Ledger,
filter = services/credit/quicknode/streams_filter.js, destination Webhook pointing at
<public credit URL>/streams/xrpl, security token copied into QUICKNODE_STREAMS_TOKEN.
"""

from __future__ import annotations

import gzip
import hashlib
import hmac
import logging
from collections.abc import Iterator
from typing import Any

import httpx

from credit import config as C
from credit.history import Tx, normalize

log = logging.getLogger("credit.streams")


def verify_signature(token: str, nonce: str, timestamp: str, payload: bytes, signature: str) -> bool:
    """HMAC-SHA256(token, nonce + timestamp + payload), hex. Payload is the decompressed body."""
    if not (token and nonce and timestamp and signature):
        return False
    message = nonce.encode() + timestamp.encode() + payload
    expected = hmac.new(token.encode(), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())


def decode_body(raw: bytes, content_encoding: str | None) -> bytes:
    if (content_encoding or "").lower() == "gzip" or raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    return raw


def network_of(label: Any) -> str:
    """Quicknode names networks like "xrpl-testnet"; fall back to STREAMS_NETWORK."""
    if isinstance(label, str):
        for name in C.NETWORKS:
            if name in label.lower():
                return name
    return C.STREAMS_NETWORK


def iter_txs(body: Any) -> Iterator[tuple[str, Tx, list[str] | None]]:
    """(network, tx, watched addresses or None) from either payload shape.

    Filtered (our filter): {"network", "matches": [{"ledgerIndex", "closeTimeIso", "addresses", "tx"}]}
    Unfiltered (no filter): {"data": [ledger, ...], "metadata": {...}} or a bare list of ledgers.
    """
    if isinstance(body, dict) and "matches" in body:
        net = network_of(body.get("network"))
        for m in body.get("matches") or []:
            tx = dict(m.get("tx") or {})
            tx.setdefault("ledger_index", m.get("ledgerIndex"))
            yield net, normalize(tx, m.get("closeTimeIso")), m.get("addresses")
        return
    meta = body.get("metadata") if isinstance(body, dict) else None
    net = network_of((meta or {}).get("network") if isinstance(meta, dict) else None)
    items = body.get("data") if isinstance(body, dict) else body
    if isinstance(items, dict):
        items = [items]
    for item in items or []:
        ledger = item.get("ledger", item) if isinstance(item, dict) else {}
        for tx in ledger.get("transactions") or []:
            if isinstance(tx, dict):
                tx = dict(tx)
                tx.setdefault("ledger_index", item.get("ledger_index") or ledger.get("ledger_index"))
                yield net, normalize(tx, ledger.get("close_time_iso")), None


async def kv_add(address: str, transport: httpx.AsyncBaseTransport | None = None) -> bool:
    """Add an address to the Quicknode KV watchlist the Streams filter reads. False when not configured."""
    if not C.QUICKNODE_API_KEY:
        return False
    headers = {"x-api-key": C.QUICKNODE_API_KEY, "accept": "application/json"}
    base, key = C.QUICKNODE_KV_URL, C.QUICKNODE_KV_LIST
    try:
        async with httpx.AsyncClient(transport=transport, timeout=10, headers=headers) as http:
            r = await http.post(f"{base}/lists/{key}/items", json={"item": address})
            if r.status_code == 404:  # list does not exist yet
                r = await http.post(f"{base}/lists", json={"key": key, "items": [address]})
            if r.status_code >= 300:
                log.warning("Quicknode KV add failed: HTTP %s", r.status_code)
                return False
            return True
    except httpx.HTTPError as e:
        log.warning("Quicknode KV add failed: %s", type(e).__name__)
        return False


async def kv_remove(address: str, transport: httpx.AsyncBaseTransport | None = None) -> bool:
    if not C.QUICKNODE_API_KEY:
        return False
    headers = {"x-api-key": C.QUICKNODE_API_KEY}
    url = f"{C.QUICKNODE_KV_URL}/lists/{C.QUICKNODE_KV_LIST}/items/{address}"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=10, headers=headers) as http:
            r = await http.delete(url)
            return r.status_code < 300
    except httpx.HTTPError:
        return False

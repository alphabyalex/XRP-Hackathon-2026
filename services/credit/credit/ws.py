"""Fallback live feed (MONITOR_MODE=websocket): XRPL WebSocket `subscribe` on watched accounts
and the `ledger` stream (ledger closes feed credit/network.py's live status).

Uses the Quicknode WSS endpoint when configured (the HTTPS URL with wss://), else the public one.
Reconnects with backoff, and resubscribes whenever the watchlist for its network changes.
"""

from __future__ import annotations

import asyncio
import json
import logging

import websockets

from credit import config as C
from credit.history import normalize
from credit.monitor import Monitor
from credit.network import status

log = logging.getLogger("credit.ws")


class AccountsFeed:
    def __init__(self, monitor: Monitor, network: str) -> None:
        self.monitor, self.network = monitor, network
        self.changed = asyncio.Event()

    async def run(self) -> None:
        backoff = 1.0
        while True:
            accounts = [w["address"] for w in self.monitor.watched(self.network)]
            if not accounts:
                self.changed.clear()
                await self.changed.wait()
                continue
            url, source = C.ws_endpoint(self.network)
            self.changed.clear()
            try:
                async with websockets.connect(url, open_timeout=15, ping_interval=20) as conn:
                    await conn.send(
                        json.dumps({"id": 1, "command": "subscribe", "accounts": accounts, "streams": ["ledger"]})
                    )
                    log.info("%s: subscribed to %d accounts via %s", self.network, len(accounts), source)
                    backoff = 1.0
                    await self._read(conn, source)
            except (OSError, websockets.WebSocketException) as e:
                log.warning(
                    "%s WebSocket via %s: %s, reconnect in %.0fs",
                    self.network,
                    source,
                    type(e).__name__,
                    backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _read(self, conn: websockets.ClientConnection, source: str = "public") -> None:
        changed = asyncio.ensure_future(self.changed.wait())
        try:
            while True:
                recv = asyncio.ensure_future(conn.recv())
                done, _ = await asyncio.wait({recv, changed}, return_when=asyncio.FIRST_COMPLETED)
                if changed in done:
                    recv.cancel()
                    return  # reconnect with the new account list
                msg = json.loads(recv.result())
                if msg.get("type") == "ledgerClosed":
                    status.on_ledger(self.network, msg, source)
                elif msg.get("id") == 1 and isinstance(msg.get("result"), dict):
                    status.on_ledger(self.network, msg["result"], source)  # the subscribe reply carries the current ledger
                elif msg.get("type") == "transaction" and msg.get("validated"):
                    # via says which feed saw it: "websocket (public devnet)", "websocket (quicknode)".
                    label = f"public {self.network}" if source == "public" else source
                    self.monitor.handle_tx(
                        self.network, normalize(msg, msg.get("close_time_iso")), f"websocket ({label})"
                    )
        finally:
            changed.cancel()


def start(monitor: Monitor) -> list[asyncio.Task[None]]:
    feeds = {n: AccountsFeed(monitor, n) for n in C.NETWORKS}
    monitor.on_watch_change = lambda network: feeds[network].changed.set() if network in feeds else None
    return [asyncio.get_running_loop().create_task(f.run()) for f in feeds.values()]

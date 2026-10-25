"""Live network status through Quicknode: ledger closes and server_info.

Two feeds, both through the endpoint the profiles use (Quicknode when configured):
  - the `ledger` stream, subscribed on the same WebSocket as the watched borrower accounts
    (credit/ws.py): every validated ledger close (index, hash, close time, base fee, reserve,
    transaction count). One connection, open only while a borrower is watched;
  - `server_info` over JSON-RPC every SERVER_INFO_SECONDS on the status network: server state,
    load factor and the validated ledger, which also covers the time no borrower is watched.
GET /network returns the latest of both. Every NETWORK_STATUS_SECONDS the status of the wallet
network is published as a NETWORK_STATUS credit event (GET /events and the api's /events), so
the credit panel's "Data via Quicknode · ledger N" moves with the ledger.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from credit.events import bus
from credit.monitor import post_to_api
from credit.xrpl_client import UpstreamError, XrplClient

log = logging.getLogger("credit.network")

SERVER_INFO_SECONDS = float(os.getenv("SERVER_INFO_SECONDS", "30"))
NETWORK_STATUS_SECONDS = float(os.getenv("NETWORK_STATUS_SECONDS", "15"))
# The network whose status the credit panel shows: where connected wallets live.
STATUS_NETWORK = os.getenv("NETWORK_STATUS_NETWORK", "testnet")

DROPS = 1_000_000


class NetworkStatus:
    def __init__(self) -> None:
        self.state: dict[str, dict[str, Any]] = {}

    def get(self, network: str) -> dict[str, Any]:
        return self.state.setdefault(network, {"network": network})

    def on_ledger(self, network: str, msg: dict[str, Any], source: str) -> None:
        """A `ledgerClosed` message (or the subscribe response, which has the same fields)."""
        idx = msg.get("ledger_index")
        if not isinstance(idx, int):
            return
        s = self.get(network)
        if idx < s.get("ledgerIndex", 0):
            return
        s.update(
            {
                "ledgerIndex": idx,
                "ledgerHash": msg.get("ledger_hash"),
                "ledgerClosedAt": msg.get("ledger_time"),
                "txnCount": msg.get("txn_count"),
                "feeBaseDrops": msg.get("fee_base"),
                "feeXrp": f"{msg['fee_base'] / DROPS:.6f}" if isinstance(msg.get("fee_base"), int) else s.get("feeXrp"),
                "reserveBaseXrp": f"{msg['reserve_base'] / DROPS:g}" if isinstance(msg.get("reserve_base"), int) else s.get("reserveBaseXrp"),
                "source": source,
                "ledgerStream": True,
                "updatedAt": time.time(),
            }
        )

    def on_server_info(self, network: str, info: dict[str, Any], source: str) -> None:
        s = self.get(network)
        vl = info.get("validated_ledger") or {}
        idx = vl.get("seq")
        if isinstance(idx, int) and idx > s.get("ledgerIndex", 0):
            s["ledgerIndex"] = idx
            s["ledgerHash"] = vl.get("hash")
        if vl.get("base_fee_xrp") is not None:
            s["feeXrp"] = f"{float(vl['base_fee_xrp']):.6f}"
        if vl.get("reserve_base_xrp") is not None:
            s["reserveBaseXrp"] = f"{float(vl['reserve_base_xrp']):g}"
        s.update(
            {
                "serverState": info.get("server_state"),
                "loadFactor": info.get("load_factor"),
                "completeLedgers": info.get("complete_ledgers"),
                "buildVersion": info.get("build_version"),
                "serverInfoAt": time.time(),
                "source": source,
                "updatedAt": time.time(),
            }
        )

    def snapshot(self) -> dict[str, Any]:
        return {"networks": list(self.state.values()), "statusNetwork": STATUS_NETWORK}


status = NetworkStatus()


async def server_info_loop(network: str) -> None:
    client = XrplClient(network)
    while True:
        try:
            status.on_server_info(network, await client.server_info(), client.source)
        except UpstreamError as e:
            log.warning("%s server_info: %s", network, e)
        await asyncio.sleep(SERVER_INFO_SECONDS)


def status_event(s: dict[str, Any]) -> dict[str, Any]:
    """A credit event the api stores and relays. One id per ledger, so a repeat is ignored."""
    return {
        "id": f"net_{s['network']}_{s['ledgerIndex']}",
        "kind": "NETWORK_STATUS",
        "severity": "info",
        "network": s["network"],
        "address": "network",
        "txHash": None,
        "ledgerIndex": s["ledgerIndex"],
        "feeXrp": s.get("feeXrp"),
        "reserveBaseXrp": s.get("reserveBaseXrp"),
        "serverState": s.get("serverState"),
        "via": s.get("source"),
        "detail": f"Ledger {s['ledgerIndex']} validated",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "simulated": False,
    }


async def publish_loop() -> None:
    last = 0
    while True:
        await asyncio.sleep(NETWORK_STATUS_SECONDS)
        s = status.state.get(STATUS_NETWORK)
        if not s or not s.get("ledgerIndex") or s["ledgerIndex"] == last:
            continue
        last = s["ledgerIndex"]
        ev = status_event(s)
        bus.publish("network", ev)
        await post_to_api(ev)


def start() -> list[asyncio.Task[None]]:
    loop = asyncio.get_running_loop()
    return [loop.create_task(server_info_loop(STATUS_NETWORK)), loop.create_task(publish_loop())]

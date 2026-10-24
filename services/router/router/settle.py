"""Devnet settlement through apps/api (POST /internal/router/pay), which signs with packages/xrpl wallets.

Money flow for one order (all TDX, shown as USDC):
  1. MS_ORDER   buyer -> order treasury (PROTOCOL_FEES): the quoted total.
  2. MS_SETTLE  order treasury -> TREASURY_GPU_A / TREASURY_GPU_B for work each GPU actually served.
                External capacity: the margin goes to the pool's treasury; the provider's cost stays in
                the order treasury, which is also the external-capacity treasury (no self-payment).
  3. MS_REFUND  order treasury -> buyer: whatever the served work did not use.
The buyer never pays more than the quote: if moves made the served work dearer, Moonshift absorbs it.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

import httpx

from router import config as C

log = logging.getLogger("router.settle")

ORDER_TREASURY = "PROTOCOL_FEES"
POOL_TREASURY = {"gpu-a": "TREASURY_GPU_A", "gpu-b": "TREASURY_GPU_B"}


class PaymentFailed(Exception):
    pass


TRANSPORT: httpx.AsyncBaseTransport | None = None  # tests inject a fake apps/api


def money(v: float) -> str:
    return f"{max(0.0, v):.6f}"


async def pay(
    from_: str,
    to: str,
    amount: str,
    memo_type: str,
    memo: dict[str, Any],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """One TDX payment. SETTLEMENT=off records the transfer without a ledger transaction."""
    if C.SETTLEMENT == "off":
        return {"hash": None, "validated": False, "explorerUrl": None, "result": "SETTLEMENT_OFF"}
    headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
    body = {"from": from_, "to": to, "amount": amount, "memoType": memo_type, "memo": memo}
    last = ""
    for _ in range(3):
        try:
            async with httpx.AsyncClient(transport=transport or TRANSPORT, timeout=60) as http:
                r = await http.post(f"{C.API_URL}/internal/router/pay", json=body, headers=headers)
            if r.status_code < 300:
                tx: dict[str, Any] = r.json()
                if tx.get("validated") and str(tx.get("result", "")).startswith("tes"):
                    return tx
                raise PaymentFailed(f"{memo_type} {tx.get('result')}")
            last = f"HTTP {r.status_code}"
            if r.status_code < 500:
                break
        except httpx.HTTPError as e:
            last = type(e).__name__
    raise PaymentFailed(f"{memo_type}: {last}")


def settlement_lines(order: dict[str, Any]) -> list[dict[str, Any]]:
    """What each GPU earned for the work it actually served, capped at what the buyer paid."""
    paid = float(order["priceUsdc"])
    earned: dict[str, float] = defaultdict(float)
    info: dict[str, dict[str, Any]] = {}
    for seg in order["segments"]:
        earned[seg["gpuId"]] += float(seg["served"]) * float(seg["unitPriceUsdc"])
        info[seg["gpuId"]] = seg
    total = sum(earned.values())
    scale = min(1.0, paid / total) if total > 0 else 0.0
    lines = []
    for gpu_id in sorted(earned):
        seg = info[gpu_id]
        amount = earned[gpu_id] * scale
        served = sum(float(s["served"]) for s in order["segments"] if s["gpuId"] == gpu_id)
        if seg["provider"] == "moonshift":
            to_pool = amount
        else:  # Moonshift keeps its margin for the pool; the provider's cost stays in the order treasury.
            to_pool = amount * C.margin() / (1 + C.margin())
        lines.append(
            {
                "gpuId": gpu_id,
                "label": seg["label"],
                "provider": seg["provider"],
                "pool": seg["pool"],
                "served": round(served, 3),
                "unit": seg["unit"],
                "amountUsdc": money(amount),
                "toPoolUsdc": money(to_pool),
                "providerCostUsdc": money(amount - to_pool),
                "to": POOL_TREASURY.get(seg["pool"], ORDER_TREASURY),
            }
        )
    return lines


def refund_amount(order: dict[str, Any], lines: list[dict[str, Any]]) -> float:
    return max(0.0, float(order["priceUsdc"]) - sum(float(x["amountUsdc"]) for x in lines))


def explorer(tx: dict[str, Any]) -> str | None:
    if tx.get("explorerUrl"):
        return str(tx["explorerUrl"])
    return f"{C.EXPLORER}/transactions/{tx['hash']}" if tx.get("hash") else None

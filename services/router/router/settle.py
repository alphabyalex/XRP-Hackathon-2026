"""Order settlement: what each GPU and provider earned, what the buyer gets back, and the old api path.

Money flow for one order (all TDX, shown as USDC). With LEDGER_SIGNER=router (default) the router signs
everything itself (router/ledger.py): the cap is locked in an XRPL escrow and settled with one Batch.
  1. MS_ORDER   buyer -> order treasury (PROTOCOL_FEES): the cap, as an escrow (or a Payment on the api path).
  2. MS_SETTLE  order treasury -> TREASURY_GPU_A / TREASURY_GPU_B for work each GPU actually served.
                External capacity: the margin goes to the pool's treasury and the provider's cost goes to that
                provider's payable account (PROVIDER_<NAME>), from which Moonshift pays the provider.
  3. MS_REFUND  order treasury -> buyer: whatever the served work did not use.

All amounts are exact decimals. Each payout is rounded down to 6 places and the buyer's refund takes every
leftover micro-unit, so for every order:  sum(pool payouts) + sum(provider payouts) + refund == cap.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from decimal import ROUND_CEILING, ROUND_DOWN, Decimal
from typing import Any

import httpx

from router import config as C

log = logging.getLogger("router.settle")

ORDER_TREASURY = C.ORDER_TREASURY
POOL_TREASURY = {"gpu-a": "TREASURY_GPU_A", "gpu-b": "TREASURY_GPU_B"}


class PaymentFailed(Exception):
    pass


TRANSPORT: httpx.AsyncBaseTransport | None = None  # tests inject a fake apps/api


Q6 = Decimal("0.000001")
ZERO = Decimal(0)


def dec(v: Any) -> Decimal:
    """Exact decimal from a 6-decimal string (or a number, via its shortest repr)."""
    return v if isinstance(v, Decimal) else Decimal(str(v))


def floor6(v: Decimal) -> Decimal:
    return v.quantize(Q6, rounding=ROUND_DOWN)


def ceil6(v: Decimal) -> Decimal:
    return v.quantize(Q6, rounding=ROUND_CEILING)


def money(v: Any) -> str:
    """6-decimal TDX string, never negative. Use on amounts already rounded the right way."""
    d = dec(v)
    return f"{max(ZERO, d).quantize(Q6):f}"


class SettlementMismatch(Exception):
    pass


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
    """What each GPU earned for the work it actually served, never more in total than the buyer set aside."""
    paid = cap_dec(order)
    earned: dict[str, Decimal] = defaultdict(Decimal)
    served_by: dict[str, Decimal] = defaultdict(Decimal)
    info: dict[str, dict[str, Any]] = {}
    for seg in order["segments"]:
        earned[seg["gpuId"]] += dec(seg["served"]) * dec(seg["unitPriceUsdc"])
        served_by[seg["gpuId"]] += dec(seg["served"])
        info[seg["gpuId"]] = seg
    total = sum(earned.values(), ZERO)
    over = total > paid  # cannot happen when the run respects the cap; if it does, scale everyone down
    margin = dec(C.margin())
    lines = []
    for gpu_id in sorted(earned):
        seg = info[gpu_id]
        amount = floor6(earned[gpu_id] * paid / total) if over else floor6(earned[gpu_id])
        if seg["provider"] == "moonshift":
            to_pool = amount
        else:  # Moonshift keeps its margin for the pool; the provider's cost goes to its payable account.
            to_pool = floor6(amount * margin / (1 + margin))
        provider_cost = amount - to_pool
        lines.append(
            {
                "gpuId": gpu_id,
                "label": seg["label"],
                "provider": seg["provider"],
                "pool": seg["pool"],
                "served": round(float(served_by[gpu_id]), 3),
                "unit": seg["unit"],
                "amountUsdc": money(amount),
                "toPoolUsdc": money(to_pool),
                "providerCostUsdc": money(provider_cost),
                "to": POOL_TREASURY.get(seg["pool"], ORDER_TREASURY),
            }
        )
    check(order, lines)
    return lines


def check(order: dict[str, Any], lines: list[dict[str, Any]]) -> None:
    """The invariant every settlement must hold before a single transaction is sent."""
    paid = cap_dec(order)
    charged = sum((dec(x["amountUsdc"]) for x in lines), ZERO)
    for x in lines:
        if dec(x["toPoolUsdc"]) + dec(x["providerCostUsdc"]) != dec(x["amountUsdc"]):
            raise SettlementMismatch(f"{x['gpuId']}: pool + provider != amount")
        if min(dec(x["amountUsdc"]), dec(x["toPoolUsdc"]), dec(x["providerCostUsdc"])) < 0:
            raise SettlementMismatch(f"{x['gpuId']}: negative amount")
    if charged > paid:
        raise SettlementMismatch(f"charged {charged} is over the cap {paid}")
    if charged + refund_dec(order, lines) != paid:
        raise SettlementMismatch("payouts + refund != cap")


def cap_dec(order: dict[str, Any]) -> Decimal:
    """What the buyer set aside (the price cap, including top-ups); orders from before caps used the quote."""
    return dec(order.get("capUsdc") or order["priceUsdc"])


def cap(order: dict[str, Any]) -> float:
    """The cap as a float, for scheduling decisions only (never for amounts that are paid)."""
    return float(cap_dec(order))


def spent(order: dict[str, Any]) -> float:
    """Cost of the work served so far, at each GPU's unit price (scheduling only)."""
    return float(sum((dec(s["served"]) * dec(s["unitPriceUsdc"]) for s in order["segments"]), ZERO))


def refund_dec(order: dict[str, Any], lines: list[dict[str, Any]]) -> Decimal:
    return max(ZERO, cap_dec(order) - sum((dec(x["amountUsdc"]) for x in lines), ZERO))


def refund_amount(order: dict[str, Any], lines: list[dict[str, Any]]) -> float:
    return float(refund_dec(order, lines))


def cap_for(estimate: Any, buffer_pct: int) -> str:
    """Max price = estimate x (1 + buffer), rounded up so the cap always covers the estimate plus buffer."""
    return money(ceil6(dec(estimate) * (1 + Decimal(buffer_pct) / 100)))


def explorer(tx: dict[str, Any]) -> str | None:
    if tx.get("explorerUrl"):
        return str(tx["explorerUrl"])
    return f"{C.EXPLORER}/transactions/{tx['hash']}" if tx.get("hash") else None

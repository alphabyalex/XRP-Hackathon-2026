"""AWS Lambda entry points (services/router/infra/template.yaml).

Collectors: EventBridge Scheduler invokes collect_handler with {"group": "spot" | "providers" |
"on_demand"}. In Lambda, PRICE_SOURCES=all and STATE_BACKEND=dynamodb come from the template, so
the same collector code calls the real APIs and writes DynamoDB + S3.
"""

from __future__ import annotations

from typing import Any

from router.scheduler import collect_group
from router.store import DynamoCatalogStore


def collect_handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    group = str(event.get("group", "providers"))
    offers, errors = collect_group(group, DynamoCatalogStore())
    return {"group": group, "offers": len(offers), "errors": errors}


def order_step_handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    """Step Functions task: {"step": "pay" | "settle" | "release", "orderId": ...}. Pointers only."""
    import asyncio

    from router.orders import Orders
    from router.service import Service
    from router.state import DynamoState

    orders = Orders(Service(), DynamoState())
    step, order_id = str(event["step"]), str(event["orderId"])
    if step == "pay":
        order = asyncio.run(orders.pay(order_id))
    elif step == "settle":
        order = asyncio.run(orders.settle(order_id))
    elif step == "release":
        asyncio.run(orders.release(order_id))
        order = orders.get(order_id) or {}
    else:
        raise ValueError(f"unknown step {step}")
    return {"ok": True, "orderId": order_id, "status": order.get("status")}

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

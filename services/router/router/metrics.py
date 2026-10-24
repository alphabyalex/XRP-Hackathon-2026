"""Router metrics and structured logs.

Every event is one JSON log line (logger router.metrics). With CLOUDWATCH=1 the same numbers also go to
Amazon CloudWatch custom metrics in namespace Moonshift/Router:
  Quotes, Orders (dimension Mode), Moves (dimension Reason), ResumeLatency (Seconds),
  PredictedCostUsdc / ActualCostUsdc (dimension Mode), CostErrorPct (actual vs predicted).
Metric calls never fail an order: errors are logged by class name only.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from typing import Any

from router import config as C

log = logging.getLogger("router.metrics")
NAMESPACE = "Moonshift/Router"

_client: Any = None
_lock = threading.Lock()
client_factory: Callable[..., Any] | None = None  # tests inject a moto-backed boto3.client


def _cw() -> Any:
    global _client
    with _lock:
        if _client is None:
            if client_factory is not None:
                _client = client_factory("cloudwatch", region_name=C.AWS_REGION)
            else:
                import boto3

                _client = boto3.client("cloudwatch", region_name=C.AWS_REGION)
        return _client


def reset() -> None:
    global _client
    _client = None


def emit(event: str, metrics: dict[str, tuple[float, str]], dims: dict[str, str] | None = None, **fields: Any) -> None:
    """One structured log line, plus CloudWatch datapoints when CLOUDWATCH=1."""
    log.info(
        json.dumps(
            {"event": event, **{k: v for k, (v, _) in metrics.items()}, **(dims or {}), **fields},
            default=str,
            separators=(",", ":"),
        )
    )
    if not C.CLOUDWATCH:
        return
    dimensions = [{"Name": k, "Value": v} for k, v in (dims or {}).items()]
    data = [
        {"MetricName": name, "Value": float(value), "Unit": unit, "Dimensions": dimensions}
        for name, (value, unit) in metrics.items()
    ]
    try:
        _cw().put_metric_data(Namespace=NAMESPACE, MetricData=data)
    except Exception as e:  # noqa: BLE001
        log.warning("cloudwatch put_metric_data failed: %s", type(e).__name__)


def quoted(plans: int, catalog_as_of: str) -> None:
    emit("quote", {"Quotes": (1, "Count"), "PlansEvaluated": (plans, "Count")}, catalogAsOf=catalog_as_of)


def ordered(order_id: str, mode: str, predicted: float) -> None:
    emit("order", {"Orders": (1, "Count"), "PredictedCostUsdc": (predicted, "None")}, {"Mode": mode}, orderId=order_id)


def moved(order_id: str, reason: str, resume_s: float, from_provider: str, to_provider: str) -> None:
    emit(
        "move",
        {"Moves": (1, "Count"), "ResumeLatency": (resume_s, "Seconds")},
        {"Reason": reason},
        orderId=order_id,
        fromProvider=from_provider,
        toProvider=to_provider,
    )


def settled(order_id: str, mode: str, predicted: float, actual: float) -> None:
    err = 0.0 if predicted <= 0 else 100.0 * (actual - predicted) / predicted
    emit(
        "settle",
        {
            "ActualCostUsdc": (actual, "None"),
            "PredictedCostUsdc": (predicted, "None"),
            "CostErrorPct": (err, "Percent"),
        },
        {"Mode": mode},
        orderId=order_id,
    )

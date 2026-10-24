"""AWS interruption events -> reclaim(gpuId, warningSeconds, reason).

EventBridge rule ms-router-interruptions (infra/template.yaml) sends these to SQS; the router consumes
the queue (or the forwarder Lambda posts them to POST /internal/aws-events). The event body is the
unmodified EventBridge event. AWS's Capacity Block samples spell the key detail_type, the Spot
samples detail-type; both are accepted.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from router import config as C

log = logging.getLogger("router.aws_events")

# detail-type -> (warning seconds, reason, move)
ACTIONS: dict[str, tuple[float, str, bool]] = {
    "EC2 Spot Instance Interruption Warning": (120.0, "RECLAIMED", True),
    "EC2 Instance Rebalance Recommendation": (0.0, "REBALANCE", False),
    # Sent 40 minutes before the block ends; instances start terminating 10 minutes later.
    "Capacity Block Expiration Warning": (600.0, "CAPACITY_BLOCK_ENDING", True),
    "EC2 Capacity Reservation Instance Interruption Warning": (0.0, "RECLAIMED", True),
}


def detail_type(event: dict[str, Any]) -> str:
    return str(event.get("detail-type") or event.get("detail_type") or "")


def targets(event: dict[str, Any], entries: list[Any]) -> list[str]:
    """Fleet GPU ids an event is about: by instance id, or by capacity reservation id."""
    detail = event.get("detail") or {}
    instance = detail.get("instance-id")
    reservation = detail.get("capacity-reservation-id")
    if not instance and not reservation:  # fall back to the resource ARN
        for arn in event.get("resources", []):
            tail = str(arn).rsplit("/", 1)[-1]
            instance = instance or (tail if tail.startswith("i-") else None)
            reservation = reservation or (tail if tail.startswith("cr-") else None)
    return [
        e.id
        for e in entries
        if (instance and e.instanceId == instance) or (reservation and e.capacityReservationId == reservation)
    ]


def handle(event: dict[str, Any], entries: list[Any], reclaim: Callable[..., list[str]]) -> dict[str, Any]:
    kind = detail_type(event)
    if event.get("source") != "aws.ec2" or kind not in ACTIONS:
        return {"ok": True, "action": "ignored", "reason": "UNSUPPORTED_EVENT"}
    gpus = targets(event, entries)
    if not gpus:
        return {"ok": True, "action": "ignored", "reason": "UNKNOWN_INSTANCE"}
    warning, reason, move = ACTIONS[kind]
    affected: list[str] = []
    for gpu in gpus:
        affected += reclaim(gpu, warning, reason, move=move)
    return {
        "ok": True,
        "action": "reclaim" if move else "checkpoint",
        "gpuIds": gpus,
        "reason": reason,
        "affectedOrders": sorted(set(affected)),
    }


async def consume_queue(
    entries: Callable[[], list[Any]], reclaim: Callable[..., list[str]], client: Callable[..., Any] | None = None
) -> None:
    """Long-poll the EventBridge -> SQS queue (AWS_EVENTS_QUEUE_URL) and apply each event."""
    if not C.AWS_EVENTS_QUEUE_URL:
        return
    if client is None:
        import boto3

        client = boto3.client
    sqs = client("sqs", region_name=C.AWS_REGION)
    while True:
        try:
            resp = await asyncio.to_thread(
                sqs.receive_message, QueueUrl=C.AWS_EVENTS_QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=20
            )
            for m in resp.get("Messages", []):
                try:
                    out = handle(json.loads(m["Body"]), entries(), reclaim)
                    log.info("aws event: %s", {k: out[k] for k in ("action", "reason") if k in out})
                finally:
                    await asyncio.to_thread(
                        sqs.delete_message, QueueUrl=C.AWS_EVENTS_QUEUE_URL, ReceiptHandle=m["ReceiptHandle"]
                    )
        except Exception as e:  # noqa: BLE001 (keep consuming)
            log.warning("aws events queue: %s", type(e).__name__)
            await asyncio.sleep(5)

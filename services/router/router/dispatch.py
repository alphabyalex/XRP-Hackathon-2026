"""Orchestration and dispatch: pay, dispatch to a tier queue, wait for the worker, settle.

ORCHESTRATOR=local      the steps run in-process (same order as the state machine).
ORCHESTRATOR=stepfunctions  one Standard execution per order (infra/statemachine/order.asl.json); its
                        Dispatch state sends {orderId, taskToken} to the tier queue and waits.
QUEUE_BACKEND=local     in-process tier queues; workers always drain fastest, then balanced, then cheapest.
QUEUE_BACKEND=sqs       ms-router-fastest / -balanced / -cheapest. Workers long-poll in tier order, extend
                        visibility while running, then delete; with a task token they report to Step
                        Functions (SendTaskSuccess, heartbeats while running).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from router import config as C
from router.orders import Orders

log = logging.getLogger("router.dispatch")

TIERS = ("fastest", "balanced", "cheapest")
VISIBILITY_SECONDS = 300
HEARTBEAT_SECONDS = 60


class LocalQueue:
    def __init__(self) -> None:
        self.queues = {t: asyncio.Queue[dict[str, Any]]() for t in TIERS}
        self.ready = asyncio.Event()

    async def send(self, tier: str, body: dict[str, Any]) -> None:
        await self.queues[tier].put(body)
        self.ready.set()

    async def receive(self) -> tuple[dict[str, Any], Callable[[], Any], Callable[[], Any]]:
        while True:
            for t in TIERS:  # strict priority
                if not self.queues[t].empty():
                    body = self.queues[t].get_nowait()
                    return body, lambda: None, lambda: None
            self.ready.clear()
            await self.ready.wait()


class SqsQueue:
    def __init__(self, client: Callable[..., Any] | None = None) -> None:
        if client is None:
            import boto3

            client = boto3.client
        self.sqs = client("sqs", region_name=C.AWS_REGION)
        self.urls = {t: self.sqs.get_queue_url(QueueName=f"{C.QUEUE_PREFIX}-{t}")["QueueUrl"] for t in TIERS}

    async def send(self, tier: str, body: dict[str, Any]) -> None:
        await asyncio.to_thread(self.sqs.send_message, QueueUrl=self.urls[tier], MessageBody=json.dumps(body))

    async def receive(self) -> tuple[dict[str, Any], Callable[[], Any], Callable[[], Any]]:
        while True:
            for i, t in enumerate(TIERS):
                resp = await asyncio.to_thread(
                    self.sqs.receive_message,
                    QueueUrl=self.urls[t],
                    MaxNumberOfMessages=1,
                    WaitTimeSeconds=0 if i < len(TIERS) - 1 else 20,
                    VisibilityTimeout=VISIBILITY_SECONDS,
                )
                for m in resp.get("Messages", []):
                    url, handle = self.urls[t], m["ReceiptHandle"]

                    def extend(url: str = url, handle: str = handle) -> Any:
                        return self.sqs.change_message_visibility(
                            QueueUrl=url, ReceiptHandle=handle, VisibilityTimeout=VISIBILITY_SECONDS
                        )

                    def delete(url: str = url, handle: str = handle) -> Any:
                        return self.sqs.delete_message(QueueUrl=url, ReceiptHandle=handle)

                    return json.loads(m["Body"]), extend, delete


class Dispatcher:
    def __init__(self, orders: Orders, queue: LocalQueue | SqsQueue, sfn: Any = None, workers: int = 4) -> None:
        self.orders, self.queue, self.sfn, self.n = orders, queue, sfn, workers
        self.tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(self.n)]

    def stop(self) -> None:
        for t in self.tasks:
            t.cancel()

    async def submit(self, order_id: str) -> dict[str, Any]:
        """Start an order: returns once it is paid (or raises PAYMENT_FAILED)."""
        order = self.orders.get(order_id)
        assert order is not None
        if C.ORCHESTRATOR == "stepfunctions":
            url = self.queue.urls[order["mode"]] if isinstance(self.queue, SqsQueue) else ""
            await asyncio.to_thread(
                self.sfn.start_execution,
                stateMachineArn=C.STATE_MACHINE_ARN,
                name=order_id,
                input=json.dumps({"orderId": order_id, "queueUrl": url}),
            )
            for _ in range(120):  # the Pay step runs in Lambda; wait for it to land in the store
                await asyncio.sleep(0.5)
                fresh = self.orders.state.get_order(order_id) or order
                if fresh.get("payment") or fresh["status"] == "failed":
                    self.orders.cache[order_id] = fresh
                    return fresh
            return order
        order = await self.orders.pay(order_id)
        await self.queue.send(order["mode"], {"orderId": order_id})
        return order

    async def _worker(self) -> None:
        while True:
            body, extend, delete = await self.queue.receive()
            order_id, token = body["orderId"], body.get("taskToken")
            beat = asyncio.create_task(self._heartbeat(extend, token))
            try:
                order = await self.orders.execute(order_id)
                if token:
                    await asyncio.to_thread(
                        self.sfn.send_task_success,
                        taskToken=token,
                        output=json.dumps({"orderId": order_id, "status": order["status"]}),
                    )
                else:
                    await self.orders.settle(order_id)
            except Exception as e:  # noqa: BLE001 (one bad order must not stop the worker)
                log.exception("order %s failed in worker: %s", order_id, type(e).__name__)
                if token:
                    await asyncio.to_thread(
                        self.sfn.send_task_failure, taskToken=token, error="WORKER_FAILED", cause=type(e).__name__
                    )
            finally:
                beat.cancel()
                await asyncio.to_thread(delete)

    async def _heartbeat(self, extend: Callable[[], Any], token: str | None) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await asyncio.to_thread(extend)
            if token:
                await asyncio.to_thread(self.sfn.send_task_heartbeat, taskToken=token)


def make_dispatcher(orders: Orders) -> Dispatcher:
    queue: LocalQueue | SqsQueue = SqsQueue() if C.QUEUE_BACKEND == "sqs" else LocalQueue()
    sfn = None
    if C.ORCHESTRATOR == "stepfunctions":
        import boto3

        sfn = boto3.client("stepfunctions", region_name=C.AWS_REGION)
    return Dispatcher(orders, queue, sfn)

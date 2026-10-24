"""Order state: orders, per-GPU slot leases, and token checkpoints.

STATE_BACKEND=dynamodb: table ms-router-orders holds orders (pk order#<id>, sk order) and leases
(pk lease#<gpuId>, sk slot#<n>); a lease is taken with a conditional write (slot free or expired),
so two orders can never hold the same slot. Checkpoints live in ms-router-checkpoints (TTL 24 h);
a body over 350 KB goes to S3 with a pointer. STATE_BACKEND=local: SQLite with the same semantics.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from router import config as C

CHECKPOINT_TTL_SECONDS = 24 * 3600
CHECKPOINT_INLINE_LIMIT = 350 * 1024


class LeaseTaken(Exception):
    pass


class StateStore(Protocol):
    def put_order(self, order: dict[str, Any]) -> None: ...

    def get_order(self, order_id: str) -> dict[str, Any] | None: ...

    def list_orders(self, limit: int = 50) -> list[dict[str, Any]]: ...

    def acquire(self, gpu: str, slots: int, order_id: str, ttl_s: float, now: float | None = None) -> int: ...

    def renew(self, gpu: str, slot: int, order_id: str, ttl_s: float, now: float | None = None) -> bool: ...

    def release(self, gpu: str, order_id: str) -> None: ...

    def holders(self, gpu: str, now: float | None = None) -> list[str]: ...

    def put_checkpoint(self, key: str, body: dict[str, Any]) -> None: ...

    def get_checkpoint(self, key: str) -> dict[str, Any] | None: ...


class SqliteState:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created TEXT, body TEXT);
                CREATE TABLE IF NOT EXISTS leases (gpu TEXT, slot INTEGER, order_id TEXT, expires REAL,
                                                   PRIMARY KEY (gpu, slot));
                CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, body TEXT, expires REAL);
                """
            )

    def put_order(self, order: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO orders VALUES (?, ?, ?)",
                (order["orderId"], order["createdAt"], json.dumps(order)),
            )

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT body FROM orders WHERE id = ?", (order_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list_orders(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM orders ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def acquire(self, gpu: str, slots: int, order_id: str, ttl_s: float, now: float | None = None) -> int:
        now = time.time() if now is None else now
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                for slot in range(slots):
                    row = self._db.execute(
                        "SELECT order_id, expires FROM leases WHERE gpu = ? AND slot = ?", (gpu, slot)
                    ).fetchone()
                    if row is None or row[1] < now or row[0] == order_id:
                        self._db.execute(
                            "INSERT OR REPLACE INTO leases VALUES (?, ?, ?, ?)", (gpu, slot, order_id, now + ttl_s)
                        )
                        self._db.execute("COMMIT")
                        return slot
                self._db.execute("ROLLBACK")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        raise LeaseTaken(gpu)

    def renew(self, gpu: str, slot: int, order_id: str, ttl_s: float, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            cur = self._db.execute(
                "UPDATE leases SET expires = ? WHERE gpu = ? AND slot = ? AND order_id = ?",
                (now + ttl_s, gpu, slot, order_id),
            )
        return cur.rowcount == 1

    def release(self, gpu: str, order_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM leases WHERE gpu = ? AND order_id = ?", (gpu, order_id))

    def holders(self, gpu: str, now: float | None = None) -> list[str]:
        now = time.time() if now is None else now
        with self._lock:
            rows = self._db.execute(
                "SELECT order_id FROM leases WHERE gpu = ? AND expires >= ? ORDER BY slot", (gpu, now)
            ).fetchall()
        return [r[0] for r in rows]

    def put_checkpoint(self, key: str, body: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?)",
                (key, json.dumps(body), time.time() + CHECKPOINT_TTL_SECONDS),
            )

    def get_checkpoint(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT body FROM checkpoints WHERE key = ? AND expires >= ?", (key, time.time())
            ).fetchone()
        return json.loads(row[0]) if row else None


class DynamoState:
    def __init__(self, client: Callable[..., Any] | None = None) -> None:
        if client is None:
            import boto3

            client = boto3.client
        self._ddb = client("dynamodb", region_name=C.AWS_REGION)
        self._s3 = client("s3", region_name=C.AWS_REGION)

    def put_order(self, order: dict[str, Any]) -> None:
        self._ddb.put_item(
            TableName=C.ORDERS_TABLE,
            Item={
                "pk": {"S": f"order#{order['orderId']}"},
                "sk": {"S": "order"},
                "createdAt": {"S": order["createdAt"]},
                "body": {"S": json.dumps(order)},
            },
        )

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        item = self._ddb.get_item(
            TableName=C.ORDERS_TABLE, Key={"pk": {"S": f"order#{order_id}"}, "sk": {"S": "order"}}
        ).get("Item")
        return json.loads(item["body"]["S"]) if item else None

    def list_orders(self, limit: int = 50) -> list[dict[str, Any]]:
        page = self._ddb.scan(
            TableName=C.ORDERS_TABLE, FilterExpression="sk = :o", ExpressionAttributeValues={":o": {"S": "order"}}
        )
        orders = [json.loads(i["body"]["S"]) for i in page.get("Items", [])]
        return sorted(orders, key=lambda o: o["createdAt"], reverse=True)[:limit]

    def acquire(self, gpu: str, slots: int, order_id: str, ttl_s: float, now: float | None = None) -> int:
        now = time.time() if now is None else now
        for slot in range(slots):
            try:
                self._ddb.put_item(
                    TableName=C.ORDERS_TABLE,
                    Item={
                        "pk": {"S": f"lease#{gpu}"},
                        "sk": {"S": f"slot#{slot}"},
                        "orderId": {"S": order_id},
                        "leaseUntil": {"N": f"{now + ttl_s:.3f}"},
                        "expiresAt": {"N": str(int(now + ttl_s) + 3600)},
                    },
                    ConditionExpression="attribute_not_exists(pk) OR leaseUntil < :now OR orderId = :me",
                    ExpressionAttributeValues={":now": {"N": f"{now:.3f}"}, ":me": {"S": order_id}},
                )
                return slot
            except self._ddb.exceptions.ConditionalCheckFailedException:
                continue
        raise LeaseTaken(gpu)

    def renew(self, gpu: str, slot: int, order_id: str, ttl_s: float, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        try:
            self._ddb.update_item(
                TableName=C.ORDERS_TABLE,
                Key={"pk": {"S": f"lease#{gpu}"}, "sk": {"S": f"slot#{slot}"}},
                UpdateExpression="SET leaseUntil = :u",
                ConditionExpression="orderId = :me",
                ExpressionAttributeValues={":u": {"N": f"{now + ttl_s:.3f}"}, ":me": {"S": order_id}},
            )
            return True
        except self._ddb.exceptions.ConditionalCheckFailedException:
            return False

    def release(self, gpu: str, order_id: str) -> None:
        page = self._ddb.query(
            TableName=C.ORDERS_TABLE,
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": f"lease#{gpu}"}},
        )
        for item in page.get("Items", []):
            if item.get("orderId", {}).get("S") == order_id:
                try:
                    self._ddb.delete_item(
                        TableName=C.ORDERS_TABLE,
                        Key={"pk": item["pk"], "sk": item["sk"]},
                        ConditionExpression="orderId = :me",
                        ExpressionAttributeValues={":me": {"S": order_id}},
                    )
                except self._ddb.exceptions.ConditionalCheckFailedException:
                    pass

    def holders(self, gpu: str, now: float | None = None) -> list[str]:
        now = time.time() if now is None else now
        page = self._ddb.query(
            TableName=C.ORDERS_TABLE,
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": f"lease#{gpu}"}},
        )
        return [
            i["orderId"]["S"]
            for i in sorted(page.get("Items", []), key=lambda i: i["sk"]["S"])
            if float(i["leaseUntil"]["N"]) >= now
        ]

    def put_checkpoint(self, key: str, body: dict[str, Any]) -> None:
        raw = json.dumps(body)
        item: dict[str, Any] = {"pk": {"S": key}, "expiresAt": {"N": str(int(time.time()) + CHECKPOINT_TTL_SECONDS)}}
        if len(raw.encode()) > CHECKPOINT_INLINE_LIMIT:  # DynamoDB items cap at 400 KB
            s3_key = f"checkpoints/{key}.json"
            self._s3.put_object(Bucket=C.PRICES_BUCKET, Key=s3_key, Body=raw.encode())
            item["s3Key"] = {"S": s3_key}
        else:
            item["body"] = {"S": raw}
        self._ddb.put_item(TableName=C.CHECKPOINTS_TABLE, Item=item)

    def get_checkpoint(self, key: str) -> dict[str, Any] | None:
        item = self._ddb.get_item(TableName=C.CHECKPOINTS_TABLE, Key={"pk": {"S": key}}).get("Item")
        if not item or int(item["expiresAt"]["N"]) < time.time():
            return None
        if "s3Key" in item:
            raw = self._s3.get_object(Bucket=C.PRICES_BUCKET, Key=item["s3Key"]["S"])["Body"].read()
            data: dict[str, Any] = json.loads(raw)
            return data
        return dict(json.loads(item["body"]["S"]))


_state: StateStore | None = None


def state_store() -> StateStore:
    global _state
    if _state is None:
        _state = DynamoState() if C.STATE_BACKEND == "dynamodb" else SqliteState(C.DB_PATH)
    return _state

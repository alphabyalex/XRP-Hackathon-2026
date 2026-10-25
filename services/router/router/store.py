"""Catalog storage: the latest offer per key, plus raw price responses for history.

STATE_BACKEND=dynamodb: DynamoDB table ms-router-catalog (pk provider#region#instanceType, sk
capacityType) and S3 bucket ms-router-prices (<provider>/<date>/<time>-<source>.json).
STATE_BACKEND=local: SQLite with the same shapes (tables catalog and price_history).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from router import config as C
from router.catalog import Availability, Offer


def offer_to_json(o: Offer) -> str:
    d = o.to_dict()
    for k in ("key", "interruptible", "pricePerHourUsdc", "pricePerGpuHourUsd"):
        d.pop(k, None)
    return json.dumps(d, sort_keys=True, default=str)


def offer_from_json(s: str) -> Offer:
    d = json.loads(s)
    d["availability"] = Availability(**d["availability"])
    return Offer(**d)


def pk(o: Offer) -> str:
    return f"{o.provider}#{o.region}#{o.instanceType}"


class CatalogStore(Protocol):
    def put_offers(self, offers: list[Offer]) -> None: ...

    def latest(self) -> list[Offer]: ...

    def append_raw(self, source: str, body: Any, now: datetime) -> str: ...


class SqliteCatalogStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS catalog (pk TEXT, sk TEXT, provider TEXT, as_of TEXT, offer TEXT,
                                                    PRIMARY KEY (pk, sk));
                CREATE TABLE IF NOT EXISTS price_history (key TEXT PRIMARY KEY, source TEXT, at TEXT, body TEXT);
                """
            )

    def put_offers(self, offers: list[Offer]) -> None:
        with self._lock:
            self._db.executemany(
                "INSERT OR REPLACE INTO catalog VALUES (?, ?, ?, ?, ?)",
                [(pk(o), o.capacityType, o.provider, o.asOf, offer_to_json(o)) for o in offers],
            )

    def latest(self) -> list[Offer]:
        with self._lock:
            rows = self._db.execute("SELECT offer FROM catalog ORDER BY pk, sk").fetchall()
        return [offer_from_json(r[0]) for r in rows]

    def append_raw(self, source: str, body: Any, now: datetime) -> str:
        provider = source.split("_")[0]
        key = f"{provider}/{now:%Y-%m-%d}/{now:%H%M%S}-{source}.json"
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO price_history VALUES (?, ?, ?, ?)",
                (key, source, now.isoformat(), json.dumps(body, default=str)),
            )
        return key

    def history(self, source: str | None = None) -> list[tuple[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT key, body FROM price_history WHERE (? IS NULL OR source = ?) ORDER BY key", (source, source)
            ).fetchall()
        return [(k, json.loads(b)) for k, b in rows]


class DynamoCatalogStore:
    def __init__(self, client: Callable[..., Any] | None = None) -> None:
        if client is None:
            import boto3

            client = boto3.client
        self._ddb = client("dynamodb", region_name=C.AWS_REGION)
        self._s3 = client("s3", region_name=C.AWS_REGION)

    def put_offers(self, offers: list[Offer]) -> None:
        for o in offers:  # a few dozen items per run: plain PutItem keeps IAM to dynamodb:PutItem
            self._ddb.put_item(
                TableName=C.CATALOG_TABLE,
                Item={
                    "pk": {"S": pk(o)},
                    "sk": {"S": o.capacityType},
                    "provider": {"S": o.provider},
                    "asOf": {"S": o.asOf},
                    "offer": {"S": offer_to_json(o)},
                },
            )

    def latest(self) -> list[Offer]:
        out: list[Offer] = []
        kwargs: dict[str, Any] = {"TableName": C.CATALOG_TABLE}
        while True:
            page = self._ddb.scan(**kwargs)
            out += [offer_from_json(i["offer"]["S"]) for i in page.get("Items", [])]
            if "LastEvaluatedKey" not in page:
                return sorted(out, key=lambda o: o.key)
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def append_raw(self, source: str, body: Any, now: datetime) -> str:
        provider = source.split("_")[0]
        key = f"{provider}/{now:%Y-%m-%d}/{now:%H%M%S}-{source}.json"
        self._s3.put_object(
            Bucket=C.PRICES_BUCKET, Key=key, Body=json.dumps(body, default=str).encode(), ContentType="application/json"
        )
        return key


_store: CatalogStore | None = None


def catalog_store() -> CatalogStore:
    global _store
    if _store is None:
        _store = DynamoCatalogStore() if C.STATE_BACKEND == "dynamodb" else SqliteCatalogStore(C.DB_PATH)
    return _store

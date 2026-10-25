"""Shared plumbing for price collectors.

Every collector is a plain function `collect(ctx) -> list[Offer]` so the same code runs in-process
(the router's background task) or as an AWS Lambda (router/lambdas.py). In mock mode a collector
parses the trimmed real response saved in fixtures/; in live mode it calls the provider.
"""

from __future__ import annotations

import json
import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx

from router import config as C
from router.catalog import iso, now_utc

log = logging.getLogger("router.collectors")


class CollectorError(Exception):
    pass


@dataclass
class CollectContext:
    now: datetime = field(default_factory=now_utc)
    secrets: dict[str, str] = field(default_factory=dict)
    transport: httpx.BaseTransport | None = None  # tests inject httpx.MockTransport
    boto_client: Callable[..., Any] | None = None  # tests inject a moto-backed factory
    live: dict[str, bool] = field(default_factory=dict)  # per-collector override of PRICE_SOURCES
    raw: list[tuple[str, Any]] = field(default_factory=list)  # raw responses, appended to S3 price history

    @property
    def as_of(self) -> str:
        return iso(self.now)

    def is_live(self, name: str) -> bool:
        return self.live.get(name, C.live_source(name))

    def client(self, service: str, region: str) -> Any:
        if self.boto_client is not None:
            return self.boto_client(service, region_name=region)
        import boto3  # imported lazily so mock mode never needs AWS

        return boto3.client(service, region_name=region)

    def record(self, source: str, body: Any) -> None:
        self.raw.append((source, body))


def fixture(name: str) -> Any:
    return json.loads((C.FIXTURES_DIR / name).read_text())


def target(provider: str) -> dict[str, Any]:
    spec: dict[str, Any] = C.load_json("collect.json")[provider]
    return spec


def http_json(
    ctx: CollectContext,
    method: str,
    url: str,
    *,
    attempts: int = 4,
    **kwargs: Any,
) -> Any:
    """GET/POST with backoff and jitter on 429 and 5xx. Never logs headers (API keys live there)."""
    last = ""
    for attempt in range(attempts):
        try:
            with httpx.Client(transport=ctx.transport, timeout=C.HTTP_TIMEOUT_SECONDS) as http:
                r = http.request(method, url, **kwargs)
            if r.status_code == 429 or r.status_code >= 500:
                last = f"HTTP {r.status_code}"
            elif r.status_code >= 400:
                raise CollectorError(f"{url.split('?')[0]}: HTTP {r.status_code}")
            else:
                return r.json()
        except httpx.HTTPError as e:
            last = type(e).__name__
        time.sleep(min(8.0, 0.5 * 2**attempt) * (0.5 + random.random() / 2))
    raise CollectorError(f"{url.split('?')[0]}: {last} after {attempts} attempts")

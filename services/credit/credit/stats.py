"""Process-wide counters for GET /stats: every upstream XRPL read, by network, source and method.

Quicknode bills XRPL reads in API credits; 40 credits per call is the figure we use for the
dashboard (CREDITS_PER_CALL). Counts reset when the service restarts. No URLs are stored.
"""

from __future__ import annotations

import statistics
import time
from collections import Counter
from datetime import UTC, datetime
from typing import Any

CREDITS_PER_CALL = 40

_started = datetime.now(UTC)
_calls: Counter[tuple[str, str, str]] = Counter()  # (network, source, method) -> upstream calls
_hits: Counter[tuple[str, str]] = Counter()  # (network, source) -> cache hits
_latency_ms: dict[str, list[float]] = {}  # source -> recent latencies
_errors: Counter[str] = Counter()


def record_call(network: str, source: str, method: str, latency_ms: float, ok: bool) -> None:
    _calls[(network, source, method)] += 1
    lst = _latency_ms.setdefault(source, [])
    lst.append(latency_ms)
    if len(lst) > 2000:
        del lst[:1000]
    if not ok:
        _errors[source] += 1


def record_hit(network: str, source: str) -> None:
    _hits[(network, source)] += 1


class Timer:
    def __enter__(self) -> "Timer":
        self.t = time.perf_counter()
        return self

    def __exit__(self, *_: Any) -> None:
        self.ms = (time.perf_counter() - self.t) * 1000


def snapshot() -> dict[str, Any]:
    by_source: dict[str, dict[str, Any]] = {}
    for (network, source, method), n in _calls.items():
        s = by_source.setdefault(source, {"calls": 0, "byNetwork": {}, "byMethod": {}})
        s["calls"] += n
        s["byNetwork"][network] = s["byNetwork"].get(network, 0) + n
        s["byMethod"][method] = s["byMethod"].get(method, 0) + n
    for source, s in by_source.items():
        hits = sum(v for (net, src), v in _hits.items() if src == source)
        lat = _latency_ms.get(source, [])
        s["cacheHits"] = hits
        s["cacheHitRate"] = round(hits / (hits + s["calls"]), 3) if hits + s["calls"] else 0.0
        s["p50LatencyMs"] = round(statistics.median(lat), 1) if lat else None
        s["errors"] = _errors.get(source, 0)
    qn = by_source.get("quicknode", {})
    total_calls = sum(_calls.values())
    total_hits = sum(_hits.values())
    return {
        "since": _started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "quicknode": {
            "calls": qn.get("calls", 0),
            "creditsUsed": qn.get("calls", 0) * CREDITS_PER_CALL,
            "creditsPerCall": CREDITS_PER_CALL,
            "p50LatencyMs": qn.get("p50LatencyMs"),
            "cacheHitRate": qn.get("cacheHitRate", 0.0),
            "byNetwork": qn.get("byNetwork", {}),
            "byMethod": qn.get("byMethod", {}),
        },
        "bySource": by_source,
        "totals": {
            "upstreamCalls": total_calls,
            "cacheHits": total_hits,
            "cacheHitRate": round(total_hits / (total_hits + total_calls), 3) if total_hits + total_calls else 0.0,
        },
        "simulated": False,
    }

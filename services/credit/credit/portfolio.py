"""Portfolio context: how borrowers in the same grade did in the (simulated) Moonshift loan book.

Reads services/risk GET /book/stats?grade=. Falls back to a mock table when risk is not reachable.
Always labeled simulated: the loan book is Kristian's simulator, not real defaults.
"""

from __future__ import annotations

import logging
import time
from decimal import Decimal
from typing import Any

import httpx

from credit import config as C

log = logging.getLogger("credit.portfolio")

# Mock loan book by grade: (loans, default rate %). PLACEHOLDER until services/risk is up.
MOCK_BOOK = {"A": (120, "0.8"), "B": (180, "2.4"), "C": (150, "5.9"), "D": (90, "12.5"), "E": (40, "24.0")}
CACHE_SECONDS = 60

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _context(grade: str, loans: int, rate: str, source: str) -> dict[str, Any]:
    return {
        "grade": grade,
        "defaultRatePct": rate,
        "loans": loans,
        "text": f"borrowers in this grade defaulted {rate}% (simulated)",
        "simulated": True,
        "source": source,
    }


def mock(grade: str) -> dict[str, Any]:
    loans, rate = MOCK_BOOK.get(grade, (0, "0.0"))
    return _context(grade, loans, rate, "mock")


def _parse(grade: str, body: dict[str, Any]) -> dict[str, Any] | None:
    loans = int(body.get("loans", 0) or 0)
    rate = body.get("defaultRatePct", body.get("default_rate_pct"))
    if rate is None and loans and "defaults" in body:
        rate = Decimal(int(body["defaults"]) * 100) / loans
    if rate is None:
        return None
    pct = f"{Decimal(str(rate)).quantize(Decimal('0.1'))}"
    return _context(grade, loans, pct, "risk")


async def context(grade: str, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    hit = _cache.get(grade)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = None
    if not C.MOCK:
        headers = {"X-MS-Internal-Key": C.INTERNAL_API_KEY} if C.INTERNAL_API_KEY else {}
        try:
            async with httpx.AsyncClient(transport=transport, timeout=2) as http:
                r = await http.get(f"{C.RISK_URL}/book/stats", params={"grade": grade}, headers=headers)
            if r.status_code == 200:
                out = _parse(grade, r.json())
        except (httpx.HTTPError, ValueError) as e:
            log.info("risk /book/stats unavailable (%s), using mock", type(e).__name__)
    out = out or mock(grade)
    _cache[grade] = (time.monotonic(), out)
    return out

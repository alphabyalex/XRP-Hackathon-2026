"""Why this score: top three positive and negative scorecard factors, from the same profile."""

from __future__ import annotations

from typing import Any

TEXT = {
    "accountAgeDays": "Account is {v} days old",
    "txCount": "{v} transactions on record",
    "paymentVolumeInXrp": "Received {v} XRP in payments",
    "paymentVolumeOutXrp": "Sent {v} XRP in payments",
    "distinctCounterparties": "Paid or was paid by {v} distinct accounts",
    "trustlines": "Holds {v} trustlines",
    "balanceStability": "Balance stability {v} (1.0 is perfectly steady)",
    "largestOutflowRatio": "Largest single payment sent was {pct}% of the balance before it",
    "msRepaysOnTime": "{v} Moonshift loans repaid on time",
    "msRepaysLate": "{v} Moonshift loans repaid late or overdue",
    "msMarginCalls": "{v} Moonshift margin calls received",
    "msLiquidations": "{v} Moonshift collateral escrows liquidated",
    "msDividendsReceived": "Received {v} Moonshift GPU dividend payments",
    "msShareTrades": "Placed {v} Moonshift GPU share or contract trades",
}


def _text(name: str, value: Any) -> str:
    if value is None:
        return f"No data for {name}"
    v = f"{float(value):g}" if isinstance(value, str) else value
    pct = round(float(value) * 100) if isinstance(value, int | float) else value
    return TEXT.get(name, name + " {v}").format(v=v, pct=pct)


def factors(profile: dict[str, Any], n: int = 3) -> dict[str, Any]:
    order = list(profile["features"])
    items = [
        {
            "feature": k,
            "value": f["value"],
            "points": f["points"],
            "reason": f["reason"],
            "text": _text(k, f["value"]),
            "txHashes": f["txHashes"],
        }
        for k, f in profile["features"].items()
    ]
    key = lambda i: (-abs(i["points"]), order.index(i["feature"]))  # noqa: E731
    return {
        "address": profile["address"],
        "network": profile["network"],
        "score": profile["score"],
        "grade": profile["grade"],
        "confidence": profile["confidence"],
        "positive": sorted((i for i in items if i["points"] > 0), key=key)[:n],
        "negative": sorted((i for i in items if i["points"] < 0), key=key)[:n],
        "source": profile["source"],
        "simulated": profile["simulated"],
        "asOf": profile["asOf"],
    }

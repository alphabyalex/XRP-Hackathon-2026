"""Transparent points scorecard. Weights live in services/credit/scorecard.json."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from typing import Any

from credit import config as C
from credit.features import Feature


@cache
def scorecard() -> dict[str, Any]:
    card: dict[str, Any] = json.loads(C.SCORECARD_FILE.read_text())
    return card


@dataclass
class Scored:
    score: int
    grade: str
    confidence: str
    raw_points: int
    cap: int | None
    features: dict[str, dict[str, Any]]
    reasons: list[str]


def _numeric(v: int | float | str | None) -> float | None:
    if v is None:
        return None
    return float(v)


def band(feature: str, value: int | float | str | None) -> tuple[int, str]:
    spec = scorecard()["features"][feature]
    x = _numeric(value)
    if x is None:
        missing = spec.get("missing", {"points": 0, "reason": f"{feature.upper()}_NO_DATA"})
        return int(missing["points"]), str(missing["reason"])
    chosen = spec["bands"][0]
    for b in spec["bands"]:
        if x >= b["min"]:
            chosen = b
    return int(chosen["points"]), str(chosen["reason"])


def grade_for(score: int) -> str:
    for g in scorecard()["grades"]:
        if score >= g["min"]:
            return str(g["grade"])
    return "E"


def score(features: dict[str, Feature]) -> Scored:
    card = scorecard()
    out: dict[str, dict[str, Any]] = {}
    total = int(card["basePoints"])
    for name in card["features"]:
        f = features[name]
        points, reason = band(name, f.value)
        total += points
        out[name] = {"value": f.value, "points": points, "reason": reason, "txHashes": f.tx_hashes}

    order = list(card["features"])
    reasons = [
        out[n]["reason"]
        for n in sorted(
            (n for n in order if out[n]["points"] != 0),
            key=lambda n: (-abs(out[n]["points"]), order.index(n)),
        )
    ]

    age = int(features["accountAgeDays"].value or 0)
    count = int(features["txCount"].value or 0)
    thin = card["thinFile"]
    high = card["highConfidence"]
    is_thin = count < thin["minTxCount"] or age < thin["minAgeDays"]

    raw = total
    final = max(0, min(100, total))
    cap = None
    if is_thin:
        reasons.append(thin["reason"])
        if final > thin["cap"]:
            final, cap = int(thin["cap"]), int(thin["cap"])
        confidence = "low"
    elif count >= high["minTxCount"] and age >= high["minAgeDays"]:
        confidence = "high"
    else:
        confidence = "medium"
    return Scored(final, grade_for(final), confidence, raw, cap, out, reasons)

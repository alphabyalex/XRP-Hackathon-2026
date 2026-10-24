"""Seeded 30-day loan book for demo defaults and grade history."""

from __future__ import annotations

import random
from decimal import Decimal
from typing import Any

from app.config import Settings
from app.models import CreditProfile
from app.risk import base_pd_for_profile, ratio6

D = Decimal
GRADES = ("A", "B", "C", "D", "E")
SCORE_RANGES = {
    "A": (80, 100),
    "B": (65, 89),
    "C": (50, 74),
    "D": (35, 59),
    "E": (0, 44),
}


def _profile(rng: random.Random, grade: str, index: int) -> CreditProfile:
    low, high = SCORE_RANGES[grade]
    confidence = D(f"{rng.uniform(0.25, 0.99):.6f}")
    return CreditProfile(
        address=f"simulated-borrower-{index:05d}",
        network="simulated",
        score=rng.randint(low, high),
        grade=grade,  # type: ignore[arg-type]
        confidence=confidence,
        features={},
        evidence=[],
        reasons=[],
    )


def _empty_counts() -> dict[str, int]:
    return {
        "repaidOnTime": 0,
        "late": 0,
        "marginCalledThenCured": 0,
        "liquidated": 0,
        "marginCalls": 0,
        "cures": 0,
    }


def build_book_stats(settings: Settings, grade_filter: str | None = None) -> dict[str, Any]:
    rng = random.Random(settings.book_sim_seed)
    counts = {grade: _empty_counts() for grade in GRADES}
    total = max(0, settings.book_sim_borrowers)

    for index in range(total):
        grade = GRADES[index % len(GRADES)]
        profile = _profile(rng, grade, index + 1)
        pd = base_pd_for_profile(profile)
        outcome_counts = counts[grade]
        if D(str(rng.random())) < pd:
            outcome_counts["liquidated"] += 1
            outcome_counts["marginCalls"] += 1
            continue

        margin_probability = min(D("0.75"), D("0.05") + pd * D("0.80"))
        if D(str(rng.random())) < margin_probability:
            outcome_counts["marginCalls"] += 1
            cure_probability = max(D("0.05"), D("0.80") - pd * D(2))
            if D(str(rng.random())) < cure_probability:
                outcome_counts["marginCalledThenCured"] += 1
                outcome_counts["cures"] += 1
            else:
                outcome_counts["liquidated"] += 1
        elif D(str(rng.random())) < pd / D(2):
            outcome_counts["late"] += 1
        else:
            outcome_counts["repaidOnTime"] += 1

    selected = [grade_filter] if grade_filter else list(GRADES)
    rows: list[dict[str, Any]] = []
    for grade in selected:
        values = counts[grade]
        loans = sum(values[key] for key in ("repaidOnTime", "late", "marginCalledThenCured", "liquidated"))
        rows.append(
            {
                "grade": grade,
                "loans": loans,
                "defaultRate": ratio6(D(values["liquidated"]) / D(loans) if loans else D(0)),
                "marginCallRate": ratio6(D(values["marginCalls"]) / D(loans) if loans else D(0)),
                "cureRate": ratio6(D(values["cures"]) / D(values["marginCalls"]) if values["marginCalls"] else D(0)),
                "outcomes": {
                    "repaidOnTime": values["repaidOnTime"],
                    "late": values["late"],
                    "marginCalledThenCured": values["marginCalledThenCured"],
                    "liquidated": values["liquidated"],
                },
                "simulated": True,
            }
        )
    return {
        "periodDays": 30,
        "borrowers": sum(row["loans"] for row in rows),
        "grades": rows,
        "simulated": True,
    }

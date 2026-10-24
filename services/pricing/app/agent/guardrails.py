"""Check model output: valid JSON, known flags only, and no numbers that are not in the input."""

from __future__ import annotations

import json
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from app.models.risk import ALLOWED_FLAGS

# A number not glued to letters or digits, so "rPT1Sj..." addresses and "24h" are ignored.
NUMBER_RE = re.compile(r"(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
MIN_SENTENCES = 2


def parse_json(raw: str) -> dict | None:
    """Accept bare JSON or JSON wrapped in prose/code fences; return None if unusable."""
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("text"), str):
        return None
    flags = obj.get("risk_flags", [])
    if not isinstance(flags, list):
        return None
    return {"text": obj["text"].strip(), "risk_flags": [f for f in flags if isinstance(f, str)]}


def _as_decimal(v: object) -> Decimal | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, Decimal)):
        return Decimal(v)
    if isinstance(v, float):
        return Decimal(str(v))
    if isinstance(v, str):
        try:
            d = Decimal(v.replace(",", "").rstrip("%"))
        except InvalidOperation:
            return None
        return d if d.is_finite() else None
    return None


def allowed_numbers(data: object, key: str = "") -> set[Decimal]:
    """Every number in the data, plus the obvious restatements (bps as %, fractions as %, list counts)."""
    out: set[Decimal] = set()
    if isinstance(data, dict):
        for k, v in data.items():
            out |= allowed_numbers(v, str(k))
    elif isinstance(data, list):
        out.add(Decimal(len(data)))
        for v in data:
            out |= allowed_numbers(v, key)
    else:
        d = _as_decimal(data)
        if d is not None:
            d = abs(d)
            out.add(d)
            if key.endswith("_bps"):
                out.add(d / 100)
            if 0 < d <= 1:
                out.add(d * 100)
    return out


def _matches(text_num: Decimal, allowed: set[Decimal]) -> bool:
    """A number in the text matches if some allowed value rounds to it at the text's precision."""
    exp = text_num.as_tuple().exponent
    places = -exp if isinstance(exp, int) and exp < 0 else 0
    q = Decimal(1).scaleb(-places)
    return any(a.quantize(q, rounding=ROUND_HALF_UP) == text_num for a in allowed)


def unknown_numbers(text: str, allowed: set[Decimal]) -> list[str]:
    bad = []
    for m in NUMBER_RE.finditer(text):
        n = _as_decimal(m.group())
        if n is not None and not _matches(n, allowed):
            bad.append(m.group())
    return bad


def scrub(text: str, allowed: set[Decimal]) -> str | None:
    """Drop sentences with unknown numbers. None if too little survives."""
    kept = [s for s in SENTENCE_SPLIT_RE.split(text) if s and not unknown_numbers(s, allowed)]
    if len(kept) < MIN_SENTENCES:
        return None
    return " ".join(kept).replace("—", ", ")


def clean_flags(flags: list[str]) -> list[str]:
    return [f for f in flags if f in ALLOWED_FLAGS]

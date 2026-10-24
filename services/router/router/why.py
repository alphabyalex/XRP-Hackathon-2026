"""Optional "why this plan" text from Amazon Bedrock (BEDROCK_EXPLAIN=1, shown only on /admin/router).

Same rule as services/pricing: Bedrock explains numbers, it never creates them. The model gets the
three chosen plans' numbers and must answer in JSON; any sentence with a number that is not in the
input is dropped, and the whole text is discarded if fewer than two sentences survive.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from decimal import Decimal, InvalidOperation
from typing import Any

from router import config as C

log = logging.getLogger("router.why")

NUMBER_RE = re.compile(r"(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])")
SYSTEM = (
    "You explain a GPU routing decision to an operator in two to four short sentences. Use only the "
    "numbers given. Say which GPU and provider each option uses and the trade between price and time. "
    'Reply as JSON: {"text": "..."}. No markdown, no em dashes.'
)


def _numbers(data: Any) -> set[Decimal]:
    out: set[Decimal] = set()
    if isinstance(data, dict):
        for v in data.values():
            out |= _numbers(v)
    elif isinstance(data, list):
        out.add(Decimal(len(data)))
        for v in data:
            out |= _numbers(v)
    elif isinstance(data, bool):
        pass
    elif isinstance(data, (int, float)):
        d = Decimal(str(data))
        out |= {d, d * 100} if 0 < d <= 1 else {d}
    elif isinstance(data, str):
        for m in NUMBER_RE.finditer(data):
            try:
                out.add(Decimal(m.group().replace(",", "")))
            except InvalidOperation:
                pass
    return out


def _allowed(token: str, allowed: set[Decimal]) -> bool:
    d = Decimal(token.replace(",", ""))
    exponent = d.as_tuple().exponent
    places = -exponent if isinstance(exponent, int) else 0
    return any(round(a, max(places, 0)) == d for a in allowed)


def guard(text: str, data: Any) -> str | None:
    allowed = _numbers(data)
    kept = [
        s
        for s in re.split(r"(?<=[.!?])\s+", text.strip())
        if s and all(_allowed(m.group(), allowed) for m in NUMBER_RE.finditer(s))
    ]
    return " ".join(kept) if len(kept) >= 2 else None


def facts(quote: dict[str, Any]) -> dict[str, Any]:
    """Only what the model may restate."""
    opts = {}
    for mode, p in quote["options"].items():
        if p.get("feasible"):
            opts[mode] = {
                "priceUsdc": p["priceUsdc"],
                "etaSeconds": p["etaSeconds"],
                "gpus": [f"{x['label']} on {x['provider']} ({x['capacityType']})" for x in p["parts"]],
                "interruptionRisk": p["interruptionRisk"],
            }
    return {"options": opts, "alternativesConsidered": quote["alternativesConsidered"]}


def explain(quote: dict[str, Any], client: Callable[..., Any] | None = None) -> str | None:
    if not C.BEDROCK_EXPLAIN:
        return None
    data = facts(quote)
    try:
        if client is None:
            import boto3
            from botocore.config import Config

            bedrock = boto3.client(
                "bedrock-runtime",
                region_name=C.AWS_REGION,
                config=Config(connect_timeout=2, read_timeout=8, retries={"max_attempts": 1}),
            )
        else:
            bedrock = client("bedrock-runtime", region_name=C.AWS_REGION)
        resp = bedrock.converse(
            modelId=C.BEDROCK_MODEL_ID,
            system=[{"text": SYSTEM}],
            messages=[{"role": "user", "content": [{"text": json.dumps(data)}]}],
            inferenceConfig={"maxTokens": 300},
        )
        raw = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
        text = json.loads(raw[raw.find("{") : raw.rfind("}") + 1]).get("text", "")
    except Exception as e:  # noqa: BLE001 (the quote never fails because of the explanation)
        log.info("bedrock why unavailable: %s", type(e).__name__)
        return None
    return guard(str(text), data)

"""Bedrock Converse client with an 8s budget and a deterministic fallback.

Logs model ID, latency and outcome only. Never logs prompt contents or credentials.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from functools import lru_cache

from app import config as C
from app.agent import fallback, guardrails
from app.agent.prompts import SYSTEM_PROMPT, user_message

log = logging.getLogger("pricing.agent")
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bedrock")


@dataclass(frozen=True)
class Explanation:
    text: str
    risk_flags: list[str]
    source: str  # "bedrock" or "fallback"
    model_id: str | None
    latency_ms: int | None


@lru_cache(maxsize=1)
def _client():
    import boto3
    from botocore.config import Config

    cfg = Config(
        connect_timeout=2,
        read_timeout=C.BEDROCK_TIMEOUT_SECONDS,
        retries={"max_attempts": 1, "mode": "standard"},
    )
    return boto3.client("bedrock-runtime", region_name=C.AWS_REGION, config=cfg)


def _converse(context: str, data: dict) -> str:
    resp = _client().converse(
        modelId=C.BEDROCK_MODEL_ID,
        system=[{"text": SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [{"text": user_message(context, data)}]}],
        inferenceConfig={"maxTokens": 600},
    )
    return "".join(b.get("text", "") for b in resp["output"]["message"]["content"])


def _merge(base: list[str], extra: list[str]) -> list[str]:
    return base + [f for f in extra if f not in base]


def explain(context: str, data: dict, base_flags: list[str]) -> Explanation:
    """Explain `data` for `context` ("dividend" | "nav" | "loan"). base_flags are deterministic."""
    payload = {**data, "risk_flags": base_flags}

    def fallback_result() -> Explanation:
        return Explanation(fallback.explain(context, data, base_flags), base_flags, "fallback", None, None)

    if C.MOCK:
        return fallback_result()

    started = time.monotonic()
    outcome = "ok"
    try:
        raw = _pool.submit(_converse, context, payload).result(timeout=C.BEDROCK_TIMEOUT_SECONDS)
        parsed = guardrails.parse_json(raw)
        if parsed is None:
            outcome = "invalid_json"
            return fallback_result()
        text = guardrails.scrub(parsed["text"], guardrails.allowed_numbers(payload))
        if text is None:
            outcome = "unverified_numbers"
            return fallback_result()
        latency = int((time.monotonic() - started) * 1000)
        flags = _merge(base_flags, guardrails.clean_flags(parsed["risk_flags"]))
        return Explanation(text, flags, "bedrock", C.BEDROCK_MODEL_ID, latency)
    except FutureTimeout:
        outcome = "timeout"
        return fallback_result()
    except Exception as e:  # noqa: BLE001 - any AWS/network failure means fallback
        outcome = f"error:{type(e).__name__}"
        return fallback_result()
    finally:
        log.info(
            "bedrock model=%s context=%s latency_ms=%d outcome=%s",
            C.BEDROCK_MODEL_ID,
            context,
            int((time.monotonic() - started) * 1000),
            outcome,
        )

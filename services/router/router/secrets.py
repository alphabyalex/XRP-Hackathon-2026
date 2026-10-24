"""Provider API keys: AWS Secrets Manager (secret moonshift/router/providers), env var fallback.

The secret is a JSON object, e.g. {"gcpApiKey": "...", "lambdaApiKey": "...", "runpodApiKey": "...",
"vastApiKey": "..."}, filled in by a human. Values are never logged; errors log only their class name.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Callable
from typing import Any

from router import config as C

log = logging.getLogger("router.secrets")

ENV_FALLBACK = {
    "gcpApiKey": "GCP_API_KEY",
    "lambdaApiKey": "LAMBDA_API_KEY",
    "runpodApiKey": "RUNPOD_API_KEY",
    "vastApiKey": "VAST_API_KEY",
}

_cache: tuple[float, dict[str, str]] | None = None
CACHE_SECONDS = 600.0


def _aws_credentials_available() -> bool:
    try:
        import boto3

        return boto3.Session().get_credentials() is not None
    except Exception:  # noqa: BLE001 (no boto3 config at all is a normal local case)
        return False


def provider_secrets(client: Callable[..., Any] | None = None, refresh: bool = False) -> dict[str, str]:
    global _cache
    if _cache and not refresh and time.monotonic() - _cache[0] < CACHE_SECONDS:
        return dict(_cache[1])
    out = {k: os.environ[v] for k, v in ENV_FALLBACK.items() if os.getenv(v)}
    if client is not None or _aws_credentials_available():
        try:
            if client is None:
                import boto3

                sm = boto3.client("secretsmanager", region_name=C.AWS_REGION)
            else:
                sm = client("secretsmanager", region_name=C.AWS_REGION)
            raw = sm.get_secret_value(SecretId=C.PROVIDER_SECRET_ID).get("SecretString") or "{}"
            stored = {k: str(v) for k, v in json.loads(raw).items() if v}
            out.update(stored)  # Secrets Manager wins over env vars
        except Exception as e:  # noqa: BLE001
            log.info("provider secrets: Secrets Manager unavailable (%s), using env fallback", type(e).__name__)
    _cache = (time.monotonic(), out)
    return dict(out)


def present() -> dict[str, bool]:
    """Which provider keys are configured. Booleans only."""
    s = provider_secrets()
    return {k: k in s for k in ENV_FALLBACK}

"""All router settings in one place.

Secrets are never read here. AWS credentials come only from boto3's default chain
(AWS_PROFILE locally, an IAM role on EC2); provider API keys come from Secrets Manager
(router/secrets.py). Anything that creates billable cloud resources is behind a flag that
defaults off.
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICE_DIR.parent.parent
CONFIG_DIR = SERVICE_DIR / "config"
FIXTURES_DIR = SERVICE_DIR / "router" / "collectors" / "fixtures"
CONTRACTS_DIR = REPO_ROOT / "contracts" / "router"

# Service-local .env wins over the repo root one. Existing process env wins over both.
load_dotenv(SERVICE_DIR / ".env")
load_dotenv(REPO_ROOT / ".env")


def _env(name: str, default: str) -> str:
    return os.getenv(name, default).strip()


def _flag(name: str, default: str = "0") -> bool:
    return _env(name, default).lower() in {"1", "true", "yes"}


# ---- Runtime ---------------------------------------------------------------------------

PORT = int(_env("PORT", "7200"))
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
API_URL = _env("API_URL", "http://localhost:4000").rstrip("/")
COMPUTE_URL = _env("COMPUTE_URL", "http://localhost:5000").rstrip("/")
EXPLORER = _env("XRPL_EXPLORER", "https://devnet.xrpl.org").rstrip("/")
DB_PATH = Path(_env("ROUTER_DB_PATH", str(SERVICE_DIR / "data" / "router.db")))

# ---- Backends: every external dependency has a local / mock mode ------------------------

FLEET_SOURCE = _env("FLEET_SOURCE", "mock").lower()  # mock | live
STATE_BACKEND = _env("STATE_BACKEND", "local").lower()  # local (SQLite) | dynamodb
QUEUE_BACKEND = _env("QUEUE_BACKEND", "local").lower()  # local | sqs
ORCHESTRATOR = _env("ORCHESTRATOR", "local").lower()  # local | stepfunctions
# Price adapters: PRICE_SOURCES=all|none|comma list of collectors to call live; the rest use fixtures.
PRICE_SOURCES = _env("PRICE_SOURCES", "none").lower()
SETTLEMENT = _env("SETTLEMENT", "api").lower()  # api (devnet through apps/api) | off

# ---- Cloud flags (billable actions default off) -----------------------------------------

AWS_REGION = _env("AWS_REGION", "us-east-2")
AWS_PRICING_REGION = "us-east-1"  # the Price List Query API endpoint
AWS_DEPLOY = _flag("AWS_DEPLOY")
AWS_LAUNCH = _flag("AWS_LAUNCH")
EXTERNAL_LAUNCH = _flag("EXTERNAL_LAUNCH")
AZURE_SPS = _flag("AZURE_SPS")
CLOUDWATCH = _flag("CLOUDWATCH")
BEDROCK_EXPLAIN = _flag("BEDROCK_EXPLAIN")
BEDROCK_MODEL_ID = _env("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
PROVIDER_SECRET_ID = _env("PROVIDER_SECRET_ID", "moonshift/router/providers")

# AWS resource names (services/router/infra/template.yaml creates them).
CATALOG_TABLE = _env("CATALOG_TABLE", "ms-router-catalog")
ORDERS_TABLE = _env("ORDERS_TABLE", "ms-router-orders")
CHECKPOINTS_TABLE = _env("CHECKPOINTS_TABLE", "ms-router-checkpoints")
PRICES_BUCKET = _env("PRICES_BUCKET", "ms-router-prices")
QUEUE_PREFIX = _env("QUEUE_PREFIX", "ms-router")
STATE_MACHINE_ARN = _env("STATE_MACHINE_ARN", "")
AWS_EVENTS_QUEUE_URL = _env("AWS_EVENTS_QUEUE_URL", "")

# ---- Catalog ----------------------------------------------------------------------------

CATALOG_MAX_AGE_SECONDS = int(_env("CATALOG_MAX_AGE", "1800"))
LAST_GOOD_FACTOR = 4  # stale offers stay usable (degraded) up to 4x CATALOG_MAX_AGE
COLLECT_INTERVALS = {"spot": 300, "providers": 900, "on_demand": 86400}
HTTP_TIMEOUT_SECONDS = float(_env("HTTP_TIMEOUT_SECONDS", "10"))

# ---- Planning model (docs/ROUTER.md) ---------------------------------------------------

MAX_PARTS = 3
SPLIT_STEPS = 12
SLOT_MINUTES = 5
RESUME_LATENCY_SECONDS = float(_env("RESUME_LATENCY_SECONDS", "2.0"))  # re-prefill + handoff
CHECKPOINT_EVERY_TOKENS = int(_env("CHECKPOINT_EVERY_TOKENS", "16"))
CHECKPOINT_FLUSH_SECONDS = 1.0
RENTAL_CHECKPOINT_SECONDS = 60.0
BOOKING_GUARD_SECONDS = 30.0
QUOTE_VALID_SECONDS = 60

# ---- Execution --------------------------------------------------------------------------

DEFAULT_BUYER = _env("ROUTER_DEFAULT_BUYER", "ALICE")
LEASE_SECONDS = 120.0
CALENDAR_CACHE_SECONDS = 10.0
DEFAULT_RECLAIM_DURATION_SECONDS = 300.0
PROGRESS_EVERY_TOKENS = 20
RENTAL_TICK_SECONDS = float(_env("RENTAL_TICK_SECONDS", "1.0"))
SSE_PING_SECONDS = 15.0
RENTAL_TIME_SCALE = float(_env("RENTAL_TIME_SCALE", "60"))  # in-process rentals: 1 rented minute per second
# In-process generation speed multiplier (1 = the GPU's real tokensPerSec; tests speed it up).
ENGINE_TIME_SCALE = float(_env("ENGINE_TIME_SCALE", "1"))


@cache
def load_json(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((CONFIG_DIR / name).read_text())
    return data


def providers() -> dict[str, Any]:
    return load_json("providers.json")


def provider(name: str) -> dict[str, Any]:
    spec: dict[str, Any] = providers()["providers"][name]
    return spec


def margin() -> float:
    return float(providers()["moonshiftMargin"])


def live_source(collector: str) -> bool:
    """Whether a price collector calls its real API (else it parses its fixture)."""
    if PRICE_SOURCES in {"", "none"}:
        return False
    return PRICE_SOURCES == "all" or collector in {s.strip() for s in PRICE_SOURCES.split(",")}

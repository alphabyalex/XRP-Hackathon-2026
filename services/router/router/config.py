"""All router settings in one place.

Secrets are never read here. AWS credentials come only from boto3's default chain
(AWS_PROFILE locally, an IAM role on EC2); provider API keys come from Secrets Manager
(router/secrets.py). Anything that creates billable cloud resources is behind a flag that
defaults off.
"""

from __future__ import annotations

import json
import os
import re
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


def service_url(value: str) -> str:
    """Local Python workers bind IPv4; localhost can reach macOS AirPlay over IPv6 instead."""
    return re.sub(r"^(https?://)localhost(?=[:/]|$)", r"\g<1>127.0.0.1", value.rstrip("/"))


# ---- Runtime ---------------------------------------------------------------------------

PORT = int(_env("PORT", "7200"))
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
API_URL = service_url(_env("API_URL", "http://127.0.0.1:4000"))
COMPUTE_URL = service_url(_env("COMPUTE_URL", "http://127.0.0.1:5001"))
# XRPL network for the order escrow and settlement. devnet or testnet only; mainnet is refused.
NETWORK = _env("NETWORK", "devnet").lower()
EXPLORER = _env("XRPL_EXPLORER", f"https://{'testnet' if NETWORK == 'testnet' else 'devnet'}.xrpl.org").rstrip("/")
DB_PATH = Path(_env("ROUTER_DB_PATH", str(SERVICE_DIR / "data" / "router.db")))

# ---- Backends: every external dependency has a local / mock mode ------------------------

FLEET_SOURCE = _env("FLEET_SOURCE", "own").lower()  # mock (tests only) | own | live
STATE_BACKEND = _env("STATE_BACKEND", "local").lower()  # local (SQLite) | dynamodb
QUEUE_BACKEND = _env("QUEUE_BACKEND", "local").lower()  # local | sqs
ORCHESTRATOR = _env("ORCHESTRATOR", "local").lower()  # local | stepfunctions
# Non-mock fleets collect live sources only. Public AWS prices need no account or credentials.
PRICE_SOURCES = _env("PRICE_SOURCES", "aws_public").lower()
SETTLEMENT = _env("SETTLEMENT", "api").lower()  # api | ledger (both: settle on XRPL) | off (tests only)
# Who signs: router (default) = services/router signs and submits with xrpl-py (EscrowCreate, Batch
# EscrowFinish + payouts + refund). api = the older path, plain Payments through apps/api /internal/router/pay.
LEDGER_SIGNER = _env("LEDGER_SIGNER", "router").lower()
ORDER_TREASURY = "PROTOCOL_FEES"  # receives every order escrow and pays the settlement
LEDGER_BATCH = _flag("LEDGER_BATCH", "1")  # 0 = always settle one transaction at a time
# The buyer's escrow can be cancelled (full refund) after max(ESCROW_MIN_SECONDS, 3 x ETA + pause timeout).
ESCROW_MIN_SECONDS = int(_env("ESCROW_MIN_SECONDS", "7200"))

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
BOOKING_DRAIN_SECONDS = 20.0  # matches services/compute DRAIN_LEAD_SECONDS
DRAIN_CHECK_SECONDS = 2.0
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

# ---- Service levels on identical GPUs (optimizer.service_levels) ------------------------
# Pausable work yields to priority work: its ETA carries this expected share of time paused.
PAUSABLE_SLOWDOWN = float(_env("PAUSABLE_SLOWDOWN", "0.3"))
PRIORITY_PREMIUM = float(_env("PRIORITY_PREMIUM", "0.25"))  # Fastest: on-demand rate plus this
# Our own GPUs' price: the real Akash lease for GPU-A plus our margin (0.160 x 1.25 = 0.200 an hour).
AKASH_LEASE_USD_PER_HOUR = float(_env("AKASH_LEASE_USD_PER_HOUR", "0.160"))
OWN_MARGIN = float(_env("OWN_MARGIN", "0.25"))
OWN_RATE_USD_PER_HOUR = round(AKASH_LEASE_USD_PER_HOUR * (1 + OWN_MARGIN), 6)
MAX_TASK_DAYS = float(_env("MAX_TASK_DAYS", "7"))  # the largest task is what the fleet finishes in this time


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
    selected = {s.strip() for s in PRICE_SOURCES.split(",")}
    parent = {
        "aws_spot_price": "aws_spot", "aws_spot_advisor": "aws_spot", "aws_placement": "aws_spot",
        "aws_pricing": "aws_on_demand", "aws_capacity_blocks": "aws_on_demand",
    }.get(collector)
    return PRICE_SOURCES == "all" or collector in selected or parent in selected

# Price cap on every order: max price = estimate x (1 + buffer). The buyer sets the cap aside up
# front; settlement charges the actual cost and refunds the rest. A paused order (cap reached)
# waits this long for a higher cap, then is cancelled and refunded.
BUFFER_CHOICES = (10, 25, 50)
DEFAULT_BUFFER_PCT = 25
PAUSE_TIMEOUT_SECONDS = float(os.getenv("PAUSE_TIMEOUT_SECONDS", "1800"))

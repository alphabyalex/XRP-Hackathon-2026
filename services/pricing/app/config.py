"""All pricing assumptions in one place.

Values marked PLACEHOLDER are demo assumptions, not measured data. The constants
mirroring packages/shared/src/constants.ts (A7) must stay in sync with that file.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

D = Decimal

SERVICE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = SERVICE_DIR / "data"

try:
    from dotenv import load_dotenv

    load_dotenv(SERVICE_DIR.parent.parent / ".env")
except ImportError:
    pass


def _env_bool(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in {"1", "true", "yes"}


# ---- Mirrors packages/shared/src/constants.ts (A7) -------------------------------

STABLE_CODE = "TDX"
STABLE_DECIMALS = 6
SLOT_MINUTES = int(os.getenv("SLOT_MINUTES", "5"))
HOSTING_FEE_BPS = 1500  # 15% placeholder
RESERVE_BPS = 500  # 5% of net revenue kept in treasury
LOAN_MAX_LTV_BPS = 5000
LOAN_APR_BPS = 1000
LOAN_DEMO_TERM_MINUTES = 10
LOAN_LIQUIDATION_LTV_BPS = 6500


@dataclass(frozen=True)
class GpuSpec:
    id: str
    label: str
    hw_class: str  # key into data/reference_prices.json
    model: str
    share_code: str
    contract_code: str
    shares_total: int
    simulated: bool


GPUS: dict[str, GpuSpec] = {
    "gpu-a": GpuSpec("gpu-a", "GPU A", "T4", "Qwen/Qwen3-1.7B", "GPA", "HRA", 1000, False),
    "gpu-b": GpuSpec("gpu-b", "GPU B", "T4", "Qwen/Qwen3-1.7B", "GPB", "HRB", 1000, True),
}

# System accounts that must never receive a dividend (A8). Matched by name and by the
# public addresses in contracts/accounts.testnet.json when that file is present.
SYSTEM_ACCOUNT_NAMES = frozenset(
    {
        "TDX_ISSUER",
        "SHARE_ISSUER",
        "CONTRACT_ISSUER",
        "TREASURY_GPU_A",
        "TREASURY_GPU_B",
        "PROTOCOL_FEES",
        "LENDING_POOL",
        "ORACLE",
    }
)

# ---- Pricing-model assumptions ------------------------------------------------------

# PLACEHOLDER until Kristian measures aggregate (batched) vLLM throughput on the T4.
TOKENS_PER_SEC = D(os.getenv("TOKENS_PER_SEC", "40"))
TOKENS_PER_SEC_IS_PLACEHOLDER = "TOKENS_PER_SEC" not in os.environ

INFERENCE_MARGIN = D("0.50")  # PLACEHOLDER: 50% over cost floor
INPUT_TO_OUTPUT_RATIO = D("0.25")  # prefill is cheaper than decode
SURCHARGE_START_UTIL = D("50")  # % utilization where surcharge begins
SURCHARGE_FULL_UTIL = D("90")  # % utilization where surcharge maxes out
SURCHARGE_MAX = D("0.30")
INFERENCE_BASE_FEE = D("0")
RATE_VALID_SECONDS = 300

SCARCITY_MAX = D("0.25")  # premium when the next 24h is fully booked
LEAD_DISCOUNT_MAX = D("0.10")
LEAD_DISCOUNT_START_HOURS = D("1")  # no discount for slots within 1h
LEAD_DISCOUNT_FULL_HOURS = D("24")  # full discount at 24h+ lead time
CONTRACT_VALID_SECONDS = 120

POWER_COST_PER_HOUR = D("0.010500")  # PLACEHOLDER: T4 70W x $0.15/kWh
BOOKED_FRACTION = D("0.20")  # PLACEHOLDER: share of utilized hours that are booked slots
USEFUL_LIFE_MONTHS = 36  # PLACEHOLDER
DISCOUNT_RATE_ANNUAL = D("0.15")  # PLACEHOLDER
HOURS_PER_MONTH = D("730")
UTIL_CLIP_MIN = D("10")
UTIL_CLIP_MAX = D("90")

# Defaults used only when the API does not pass live values (mock / early integration).
DEFAULT_UTILIZATION_PCT = D("50")  # PLACEHOLDER
DEFAULT_BOOKED_SHARE_24H = D("0")
DEFAULT_TREASURY_CASH = D("0")

# "outstanding": each share earns distributable / 1,000 and treasury-held shares' portion stays in
# the treasury. "held": split only among outside holders (early buyers get everything).
DIVIDEND_DENOMINATOR = "outstanding"

# Risk-flag thresholds
CONCENTRATED_HOLDER_PCT = D("40")  # of shares outstanding
HIGH_LTV_PCT = D("45")  # loan flagged when requested principal is within 5 points of the 50% cap
LOW_UTILIZATION_PCT = D("20")
REVENUE_SPIKE_MULTIPLE = D("2")

# ---- Runtime ---------------------------------------------------------------------------

MOCK = _env_bool("MOCK")
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
BEDROCK_TIMEOUT_SECONDS = float(os.getenv("BEDROCK_TIMEOUT_SECONDS", "12"))
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
ACCOUNTS_FILE = Path(
    os.getenv("ACCOUNTS_FILE", str(SERVICE_DIR.parent.parent / "contracts" / "accounts.testnet.json"))
)


def load_reference_prices() -> dict:
    with open(DATA_DIR / "reference_prices.json") as f:
        return json.load(f)


def reference_hourly(hw_class: str) -> Decimal:
    for row in load_reference_prices()["gpus"]:
        if row["gpu"] == hw_class:
            return D(row["usd_per_gpu_hour"])
    raise KeyError(f"no reference price for {hw_class}")


def system_addresses() -> frozenset[str]:
    """Public addresses of system accounts, if the accounts file has been generated."""
    if not ACCOUNTS_FILE.exists():
        return frozenset()
    try:
        data = json.loads(ACCOUNTS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return frozenset()
    out: set[str] = set()
    for name, value in data.items() if isinstance(data, dict) else []:
        if name.upper() in SYSTEM_ACCOUNT_NAMES:
            addr = value.get("address") if isinstance(value, dict) else value
            if isinstance(addr, str):
                out.add(addr)
    return frozenset(out)

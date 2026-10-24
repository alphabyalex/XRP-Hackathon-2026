"""All credit service settings in one place.

Quicknode endpoint URLs contain an auth token. They are read here and only ever
handed to the HTTP/WebSocket clients. Never log, print or return them.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVICE_DIR.parent.parent
CONTRACTS_DIR = REPO_ROOT / "contracts" / "credit"
SCORECARD_FILE = SERVICE_DIR / "scorecard.json"

# Service-local .env wins over the repo root one. Existing process env wins over both.
load_dotenv(SERVICE_DIR / ".env")
load_dotenv(REPO_ROOT / ".env")


def _env_bool(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class Network:
    name: str
    quicknode_env: str | None  # env var with the Quicknode HTTPS URL; None when Quicknode lacks the network
    public_http: str
    public_ws: str
    read_only: bool  # mainnet history is scored read-only; Moonshift never transacts there


NETWORKS: dict[str, Network] = {
    "mainnet": Network(
        "mainnet", "QUICKNODE_XRPL_MAINNET_URL", "https://xrplcluster.com/", "wss://xrplcluster.com/", True
    ),
    "testnet": Network(
        "testnet",
        "QUICKNODE_XRPL_TESTNET_URL",
        "https://s.altnet.rippletest.net:51234/",
        "wss://s.altnet.rippletest.net:51233/",
        False,
    ),
    # Quicknode's docs list only mainnet and testnet for XRPL (checked 2026-10-24). If the dashboard
    # offers a devnet endpoint, setting QUICKNODE_XRPL_DEVNET_URL routes devnet through it.
    "devnet": Network(
        "devnet",
        "QUICKNODE_XRPL_DEVNET_URL",
        "https://s.devnet.rippletest.net:51234/",
        "wss://s.devnet.rippletest.net:51233/",
        False,
    ),
}


def endpoint(network: str) -> tuple[str, str]:
    """(http_url, source) for a network. source is "quicknode" or "public"."""
    net = NETWORKS[network]
    url = os.getenv(net.quicknode_env, "").strip() if net.quicknode_env else ""
    return (url, "quicknode") if url else (net.public_http, "public")


def ws_endpoint(network: str) -> tuple[str, str]:
    """(wss_url, source). Quicknode issues the WSS URL as the HTTPS URL with the scheme swapped."""
    url, source = endpoint(network)
    if source == "quicknode":
        return "wss://" + url.split("://", 1)[1], source
    return NETWORKS[network].public_ws, source


def quicknode_configured() -> dict[str, bool]:
    """Per network, whether a Quicknode endpoint is set. Booleans only, never the URL."""
    return {name: endpoint(name)[1] == "quicknode" for name in NETWORKS}


# ---- Runtime ---------------------------------------------------------------------------

MOCK = _env_bool("MOCK", "1")
PORT = int(os.getenv("PORT", "7100"))
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "")
API_URL = os.getenv("API_URL", "http://localhost:4000").rstrip("/")
RISK_URL = os.getenv("RISK_URL", "http://localhost:7000").rstrip("/")
DB_PATH = Path(os.getenv("CREDIT_DB_PATH", str(SERVICE_DIR / "data" / "credit.db")))
ACCOUNTS_FILE = Path(os.getenv("ACCOUNTS_FILE", str(REPO_ROOT / "contracts" / "accounts.testnet.json")))

# ---- Data fetch (Phase 2) -------------------------------------------------------------

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "900"))
ACCOUNT_TX_PAGE_LIMIT = 200  # rippled caps account_tx pages; 200 keeps responses small
ACCOUNT_TX_MAX_PAGES = int(os.getenv("ACCOUNT_TX_MAX_PAGES", "10"))  # 2,000 newest txs, then truncated
HTTP_TIMEOUT_SECONDS = float(os.getenv("HTTP_TIMEOUT_SECONDS", "15"))
RETRY_ATTEMPTS = 5
RETRY_BASE_SECONDS = 0.5  # exponential backoff: 0.5, 1, 2, 4 s
QUICKNODE_MIN_INTERVAL_SECONDS = 0.07  # stays under the free plan's 15 requests per second
# Public servers answer paged account_tx bursts with slowDown/tooBusy (seen on mainnet, 2026-10-24).
PUBLIC_MIN_INTERVAL_SECONDS = float(os.getenv("PUBLIC_MIN_INTERVAL_SECONDS", "1.0"))
BATCH_MAX_ITEMS = 20

# ---- Live monitoring (Phase 5) --------------------------------------------------------

MONITOR_MODE = os.getenv("MONITOR_MODE", "streams").strip().lower()  # streams | websocket | off
QUICKNODE_STREAMS_TOKEN = os.getenv("QUICKNODE_STREAMS_TOKEN", "")
QUICKNODE_API_KEY = os.getenv("QUICKNODE_API_KEY", "")
QUICKNODE_KV_URL = "https://api.quicknode.com/kv/rest/v1"
QUICKNODE_KV_LIST = os.getenv("QUICKNODE_KV_LIST", "moonshift-borrowers")
# Network the Quicknode Stream reads, used when a delivery does not name one.
STREAMS_NETWORK = os.getenv("STREAMS_NETWORK", "testnet").strip().lower()
# Local testing only: accept Streams deliveries without a valid X-QN-Signature.
STREAMS_ALLOW_UNSIGNED = _env_bool("STREAMS_ALLOW_UNSIGNED", "0")
CREDIT_EVENT_POST_ATTEMPTS = 3
LARGE_OUTFLOW_RATIO = float(os.getenv("LARGE_OUTFLOW_RATIO", "0.5"))
MISSED_PAYMENT_CHECK_SECONDS = 15
SSE_PING_SECONDS = 15

# ---- Moonshift on-ledger names (packages/xrpl) ---------------------------------------

MEMO_REPAY = "MS_REPAY"
MEMO_LOAN_DISBURSE = "MS_LOAN_DISBURSE"
MEMO_MARGIN_CALL = "MS_MARGIN_CALL"  # proposed, see request in docs/CONTRACTS.md
# packages/xrpl sets CancelAfter = dueAt + 120 s on the collateral escrow.
LOAN_CANCEL_GRACE_SECONDS = 120
RIPPLE_EPOCH_OFFSET = 946684800


def lender_addresses() -> frozenset[str]:
    """Accounts whose EscrowFinish on a borrower's escrow counts as a liquidation.

    LENDING_POOL from contracts/accounts.testnet.json, plus any in LENDER_ADDRESSES (comma separated).
    """
    out = {a.strip() for a in os.getenv("LENDER_ADDRESSES", "").split(",") if a.strip()}
    if ACCOUNTS_FILE.exists():
        try:
            data = json.loads(ACCOUNTS_FILE.read_text())
            pool = data.get("LENDING_POOL", {})
            addr = pool.get("address") if isinstance(pool, dict) else pool
            if isinstance(addr, str):
                out.add(addr)
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    return frozenset(out)

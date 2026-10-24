"""Risk desk configuration. Secrets are read only from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value is not None else default


def _decimal(name: str, default: str) -> str:
    return os.getenv(name, default)


SERVICE_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True, slots=True)
class Settings:
    mock: bool = True
    api_url: str = ""
    internal_api_key: str = ""
    keeper_interval_seconds: int = 15
    cure_seconds: int = 120
    keeper_dry_run: bool = True
    demo_shock_enabled: bool = False
    default_term_seconds: int = 600
    payment_interval_seconds: int = 60
    first_loss_cover_usdc: str = "250.000000"
    vault_deposits_usdc: str = "10000.000000"
    book_sim_borrowers: int = 500
    book_sim_seed: int = 20261024
    state_dir: Path = SERVICE_DIR / ".state"

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            mock=_bool("MOCK", True),
            api_url=os.getenv("API_URL", "").rstrip("/"),
            internal_api_key=os.getenv("INTERNAL_API_KEY", ""),
            keeper_interval_seconds=_int("KEEPER_INTERVAL_SECONDS", 15),
            cure_seconds=_int("CURE_SECONDS", 120),
            keeper_dry_run=_bool("KEEPER_DRY_RUN", True),
            demo_shock_enabled=_bool("DEMO_SHOCK_ENABLED", False),
            default_term_seconds=_int("DEFAULT_TERM_SECONDS", 600),
            payment_interval_seconds=_int("PAYMENT_INTERVAL_SECONDS", 60),
            first_loss_cover_usdc=_decimal("FIRST_LOSS_COVER_USDC", "250.000000"),
            vault_deposits_usdc=_decimal("VAULT_DEPOSITS_USDC", "10000.000000"),
            book_sim_borrowers=_int("BOOK_SIM_BORROWERS", 500),
            book_sim_seed=_int("BOOK_SIM_SEED", 20261024),
            state_dir=Path(os.getenv("RISK_STATE_DIR", str(SERVICE_DIR / ".state"))),
        )


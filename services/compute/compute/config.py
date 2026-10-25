"""Configuration for the compute service.

Secrets are intentionally read only from the environment. Do not put values
for INTERNAL_API_KEY or cloud credentials in a checked-in file.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")
except ImportError:
    pass


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value is not None else default


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value is not None else default


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings with conservative defaults for local mock mode."""

    mock: bool
    api_url: str
    pricing_url: str
    internal_api_key: str
    vllm_url: str
    gpu_b_vllm_url: str
    model: str
    gpu_b_mode: str
    slot_minutes: int
    guard_seconds: float
    drain_lead_seconds: float
    prefill_seconds: float
    network_seconds: float
    request_timeout_seconds: float
    public_input_token_limit: int
    public_max_tokens: int
    gpu_a_tokens_per_sec: float
    gpu_b_tokens_per_sec: float
    mock_latency_seconds: float
    state_dir: Path
    pricing_cache_seconds: int
    gpu_nodes: tuple[str, ...] = ("gpu-a", "gpu-b")
    upstream_model: str = "Qwen/Qwen3-1.7B"

    def endpoint(self, gpu_id: str) -> str:
        if gpu_id == "gpu-a":
            return self.vllm_url
        if gpu_id == "gpu-b":
            return self.gpu_b_vllm_url
        return os.getenv(f"{gpu_id.upper().replace('-', '_')}_VLLM_URL", "").strip()

    def node_mode(self, gpu_id: str) -> str:
        fallback = "real" if gpu_id == "gpu-a" else self.gpu_b_mode if gpu_id == "gpu-b" else ""
        return os.getenv(f"{gpu_id.upper().replace('-', '_')}_MODE", fallback).strip().lower()

    def canonical_model(self, gpu_id: str) -> str:
        prefix = gpu_id.upper().replace("-", "_")
        fallback = self.model if self.mock or gpu_id == "gpu-a" else ""
        return os.getenv(f"{prefix}_MODEL_ID", fallback).strip()

    def tokens_per_second(self, gpu_id: str) -> float:
        prefix = gpu_id.upper().replace("-", "_")
        fallback = (self.gpu_a_tokens_per_sec if gpu_id == "gpu-a" else
                    self.gpu_b_tokens_per_sec if gpu_id == "gpu-b" or self.mock else 0)
        value = os.getenv(f"{prefix}_PLANNING_TOKENS_PER_SEC", os.getenv(f"{prefix}_TOKENS_PER_SEC", str(fallback)))
        try:
            rate = float(value)
            if not self.mock and (gpu_id not in {"gpu-a", "gpu-b"} or os.getenv(f"{prefix}_PLANNING_TOKENS_PER_SEC")):
                observed = datetime.fromisoformat(os.getenv(f"{prefix}_PLANNING_OBSERVED_AT", "").replace("Z", "+00:00"))
                if (os.getenv(f"{prefix}_PLANNING_MODEL_ID") != self.canonical_model(gpu_id)
                        or int(os.getenv(f"{prefix}_PLANNING_SAMPLE_COUNT", "0")) < 2
                        or observed.tzinfo is None or (datetime.now(UTC) - observed).total_seconds() < -300):
                    return 0
            return rate if math.isfinite(rate) and rate > 0 else 0
        except ValueError:
            return 0

    def wire_model(self, gpu_id: str) -> str:
        prefix = gpu_id.upper().replace("-", "_")
        return os.getenv(f"{prefix}_WIRE_MODEL", os.getenv(f"{prefix}_VLLM_MODEL",
            self.upstream_model if gpu_id == "gpu-a" else self.canonical_model(gpu_id))).strip()

    @classmethod
    def from_env(cls) -> "Settings":
        mock = _bool("MOCK", True)
        gpu_b_mode = os.getenv("GPU_B_MODE", "simulated").strip().lower()
        if gpu_b_mode not in {"real", "simulated"}:
            raise ValueError("GPU_B_MODE must be 'real' or 'simulated'")

        key = os.getenv("INTERNAL_API_KEY", "dev-internal-key" if mock else "")
        if not key:
            raise ValueError("INTERNAL_API_KEY is required when MOCK is disabled")
        gpu_b_vllm_url = os.getenv("GPU_B_VLLM_URL", "").rstrip("/")
        if not mock and gpu_b_mode == "real" and not gpu_b_vllm_url:
            gpu_b_mode = "simulated"

        nodes = tuple(x.strip() for x in os.getenv("GPU_NODES", "gpu-a,gpu-b").split(",") if x.strip())
        if len(set(nodes)) != len(nodes) or any(not re.fullmatch(r"gpu-[a-h]", gid) for gid in nodes):
            raise ValueError("GPU_NODES must contain distinct GPU IDs from gpu-a through gpu-h")
        return cls(
            mock=mock,
            api_url=os.getenv("API_URL", "").rstrip("/"),
            pricing_url=os.getenv("PRICING_URL", "").rstrip("/"),
            internal_api_key=key,
            vllm_url=os.getenv("GPU_A_VLLM_URL", os.getenv("VLLM_URL", "http://127.0.0.1:8000")).rstrip("/"),
            gpu_b_vllm_url=gpu_b_vllm_url,
            model=(
                "Qwen/Qwen2.5-1.5B-Instruct"
                if os.getenv("MODEL", "Qwen/Qwen3-1.7B") == "Qwen/Qwen3-1.7B"
                else os.environ["MODEL"]
            ),
            gpu_b_mode=gpu_b_mode,
            slot_minutes=_int("SLOT_MINUTES", 5),
            guard_seconds=_float("BOOKING_GUARD_SECONDS", 10.0),
            drain_lead_seconds=_float("DRAIN_LEAD_SECONDS", 20.0),
            prefill_seconds=_float("PREFILL_SECONDS", 1.5),
            network_seconds=_float("NETWORK_SECONDS", 1.0),
            request_timeout_seconds=_float("REQUEST_TIMEOUT_SECONDS", 90.0),
            public_input_token_limit=_int("PUBLIC_INPUT_TOKEN_LIMIT", 2000),
            public_max_tokens=_int("PUBLIC_MAX_TOKENS", 256),
            gpu_a_tokens_per_sec=_float("GPU_A_TOKENS_PER_SEC", 30.0),
            gpu_b_tokens_per_sec=_float("GPU_B_TOKENS_PER_SEC", 24.0),
            mock_latency_seconds=_float("MOCK_LATENCY_SECONDS", 0.05),
            state_dir=Path(os.getenv("COMPUTE_STATE_DIR", ".state")),
            pricing_cache_seconds=_int("PRICING_CACHE_SECONDS", 60),
            gpu_nodes=nodes,
            upstream_model=os.getenv("GPU_A_VLLM_MODEL", os.getenv("MODEL", "Qwen/Qwen3-1.7B")),
        )

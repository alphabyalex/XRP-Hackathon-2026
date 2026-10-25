"""Observe existing verified nodes. No ledger, lease, AWS or deployment actions.

Run with the router virtualenv after hardware/model verification:
  python services/router/measure_planning.py gpu-c gpu-d --write-env
The only requests are /v1/models and two max-128-token chat requests per node.
Private URLs and prompts never enter receipts or standard output.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import time

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]


def normalized_endpoint(value: str) -> str:
    return value.strip().rstrip("/").removesuffix("/v1")


def performance_record(gpu_id: str, model: str, samples: list[dict]) -> dict:
    if len(samples) != 2:
        raise ValueError("Two completed observations are required")
    rates = []
    for sample in samples:
        tokens, seconds = sample["completionTokens"], sample["wallSeconds"]
        if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 64 or tokens > 128:
            raise ValueError("Observation must complete between 64 and 128 output tokens")
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("Invalid request duration")
        rates.append(tokens / seconds)
    return {"gpuId": gpu_id, "modelId": model, "observedAt": samples[-1]["observedAt"],
            "source": "minimum_observed_end_to_end", "sampleCount": len(samples),
            "planningTokensPerSec": round(min(rates), 6), "samples": samples,
            "scope": "Completed output tokens divided by full HTTP wall time, including prefill and network time. A conservative planning observation, not pure decoder throughput or a future guarantee."}


def update_settings(path: Path, settings: dict[str, str]) -> None:
    text = path.read_text()
    for key, value in settings.items():
        line = f"{key}={value}"
        pattern = rf"(?m)^{re.escape(key)}=.*$"
        if re.search(pattern, text):
            text = re.sub(pattern, lambda _: line, text)
        else:
            text = text.rstrip("\n") + "\n" + line + "\n"
    path.write_text(text)


def measure(gpu_id: str, env: dict[str, str | None], client: httpx.Client) -> dict:
    prefix = gpu_id.upper().replace("-", "_")
    endpoint = normalized_endpoint(env.get(f"{prefix}_VLLM_URL") or "")
    canonical = env.get(f"{prefix}_MODEL_ID") or ""
    wire = env.get(f"{prefix}_WIRE_MODEL") or env.get(f"{prefix}_VLLM_MODEL") or canonical
    if not endpoint or env.get(f"{prefix}_MODE") != "real" or canonical != "Qwen/Qwen2.5-3B-Instruct":
        raise ValueError("Node must already be verified in real mode with the approved Qwen2.5-3B model")
    resources = [int(env.get(f"{prefix}_{key}") or "0") for key in ("VRAM_GB", "VCPU", "RAM_GB", "STORAGE_GB")]
    cost = float(env.get(f"{prefix}_LEASE_USD_PER_HOUR") or "nan")
    if not env.get(f"{prefix}_CARD") or min(resources) <= 0 or not math.isfinite(cost) or cost <= 0 or not env.get(f"{prefix}_PRICE_UPDATED_AT"):
        raise ValueError("Verified physical specs and lease price are required before measurement")
    health = client.get(f"{endpoint}/v1/models")
    health.raise_for_status()
    served = health.json().get("data", [])
    if not any(row.get("id") == wire and row.get("root", row.get("id")) == canonical for row in served):
        raise ValueError("Endpoint model does not match verified canonical and wire identity")
    samples = []
    for _ in range(2):
        start = time.perf_counter()
        response = client.post(f"{endpoint}/v1/chat/completions", json={
            "model": wire, "messages": [{"role": "user", "content": "Count the integers from 1 through 80, separated by spaces. Continue counting without any explanation."}],
            "max_tokens": 128, "temperature": 0,
        })
        response.raise_for_status()
        body = response.json()
        elapsed = time.perf_counter() - start
        if body.get("model") != wire or not body.get("choices", [{}])[0].get("message", {}).get("content"):
            raise ValueError("No completed reply from the verified model")
        samples.append({"observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "completionTokens": body.get("usage", {}).get("completion_tokens"),
                        "wallSeconds": round(elapsed, 9)})
    return performance_record(gpu_id, canonical, samples)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gpu_ids", nargs="+")
    parser.add_argument("--write-env", action="store_true")
    args = parser.parse_args()
    ids = list(dict.fromkeys(args.gpu_ids))
    if len(ids) != len(args.gpu_ids) or any(not re.fullmatch(r"gpu-[c-h]", gpu_id) for gpu_id in ids):
        raise SystemExit("Choose each new physical node gpu-c through gpu-h at most once")
    env_path = ROOT / ".env"
    env = dict(dotenv_values(env_path))
    endpoints = {}
    for letter in "abcdefgh":
        node = f"gpu-{letter}"
        url = normalized_endpoint(env.get(f"GPU_{letter.upper()}_VLLM_URL") or "")
        if url:
            if url in endpoints and (node in ids or endpoints[url] in ids):
                raise SystemExit("A requested node duplicates an existing physical endpoint")
            endpoints[url] = node
    settings = {}
    for gpu_id in ids:
        try:
            with httpx.Client(timeout=45, follow_redirects=False) as client:
                record = measure(gpu_id, env, client)
        except Exception:
            # HTTP errors can contain the private endpoint. No raw exceptions.
            raise SystemExit(f"Observation failed for {gpu_id}; no retry was made. Check the node privately.") from None
        letter = gpu_id[-1]
        receipt = ROOT / "contracts/compute" / f"observed_gpu_{letter}_throughput.json"
        receipt.write_text(json.dumps(record, indent=2) + "\n")
        prefix = gpu_id.upper().replace("-", "_")
        settings.update({f"{prefix}_PLANNING_TOKENS_PER_SEC": str(record["planningTokensPerSec"]),
                         f"{prefix}_TOKENS_PER_SEC": str(record["planningTokensPerSec"]),
                         f"{prefix}_PLANNING_MODEL_ID": record["modelId"],
                         f"{prefix}_PLANNING_OBSERVED_AT": record["observedAt"],
                         f"{prefix}_PLANNING_SAMPLE_COUNT": "2"})
        # Persist each fully observed node independently if a later node fails.
        if args.write_env:
            update_settings(env_path, settings)
        print(json.dumps({"gpuId": gpu_id, "planningTokensPerSec": record["planningTokensPerSec"],
                          "receipt": str(receipt.relative_to(ROOT)), "envUpdated": args.write_env}), flush=True)


if __name__ == "__main__":
    main()

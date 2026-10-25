"""Render a pinned SDL and create an inert deployment using native secret input.

Never put secret values in the SDL, command arguments, logs, or Git. This script
passes the allowlisted runtime settings to akt through its stdin pipe.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PRIVATE = Path.home() / ".local/state/moonshift/backend"


def dotenv(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        match = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)\s*$", line)
        if match:
            key, value = match.groups()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[key] = value
    return result


def runtime_settings() -> dict[str, str]:
    exact = {"INTERNAL_API_KEY", "ADMIN_KEY", "MOONSHIFT_ACCOUNT_KEY", "DEVNET_WSS", "XRPL_WSS",
             "QUICKNODE_WSS", "QUICKNODE_XRPL_MAINNET_URL", "QUICKNODE_XRPL_TESTNET_URL", "SLOT_MINUTES",
             "AKASH_LEASE_USD_PER_HOUR", "OWN_MARGIN", "OWN_PRICE_UPDATED_AT", "GPU_NODES"}
    result = {key: value for key, value in dotenv(ROOT / ".env").items() if value and
              (key in exact or re.fullmatch(r"DEVNET_[A-Z_]+_SEED", key) or
               re.fullmatch(r"GPU_[A-H]_(MODE|VLLM_URL|VLLM_MODEL|WIRE_MODEL|MODEL_ID|CARD|VRAM_GB|VCPU|RAM_GB|STORAGE_GB|CITY|REGION|PROVIDER|LEASE_USD_PER_HOUR|PRICE_UPDATED_AT|OWN_MARGIN|TOKENS_PER_SEC|PLANNING_TOKENS_PER_SEC|PLANNING_OBSERVED_AT|PLANNING_MODEL_ID|PLANNING_SAMPLE_COUNT)", key))}
    # Separate strong operator keys for the public backend. Preserve the account
    # encryption key so existing wallet accounts and sessions remain usable.
    previous = PRIVATE / "secrets.json"
    existing = json.loads(previous.read_text()) if previous.exists() else {}
    for key in ("INTERNAL_API_KEY", "ADMIN_KEY"):
        result[key] = existing.get(key) or secrets.token_hex(32)
    if len(result.get("MOONSHIFT_ACCOUNT_KEY", "")) != 64:
        raise RuntimeError("The existing account encryption key is required")
    if not result.get("GPU_A_VLLM_URL") or not result.get("GPU_B_VLLM_URL") or result["GPU_A_VLLM_URL"].rstrip("/") == result["GPU_B_VLLM_URL"].rstrip("/"):
        raise RuntimeError("Two distinct verified GPU endpoints are required")
    if result.get("GPU_B_MODE") != "real" or not result.get("GPU_B_MODEL_ID"):
        raise RuntimeError("The second GPU must be verified and configured")
    result.setdefault("GPU_A_MODEL_ID", "Qwen/Qwen2.5-1.5B-Instruct")
    nodes = result.get("GPU_NODES", "gpu-a,gpu-b").split(",")
    nodes = [node.strip() for node in nodes]
    if len(set(nodes)) != len(nodes) or any(not re.fullmatch(r"gpu-[a-h]", node) for node in nodes):
        raise RuntimeError("GPU_NODES must name distinct supported workers")
    endpoints: set[str] = set()
    for node in nodes:
        prefix = node.upper().replace("-", "_")
        endpoint = result.get(f"{prefix}_VLLM_URL", "").strip().rstrip("/").removesuffix("/v1")
        endpoint = re.sub(r"^(https?://)localhost(?=[:/]|$)", r"\g<1>127.0.0.1", endpoint)
        if not endpoint or endpoint in endpoints:
            raise RuntimeError("Every enabled worker requires its own verified endpoint")
        if result.get(f"{prefix}_MODE", "real" if node == "gpu-a" else "") != "real" or not result.get(f"{prefix}_MODEL_ID"):
            raise RuntimeError("Every enabled worker requires a verified canonical model and real mode")
        endpoints.add(endpoint)
    result["GPU_NODES"] = ",".join(nodes)
    return result


def render_environment(template: str, settings: dict[str, str]) -> tuple[str, dict[str, str]]:
    # Hardware/model/price metadata is public configuration. Keeping it in the
    # secret store exhausts Console's 100-secret deployment limit as the fleet
    # expands. Credentials, private RPC URLs and GPU endpoints stay native secrets.
    private = {key: value for key, value in settings.items() if
               key in {"INTERNAL_API_KEY", "ADMIN_KEY", "MOONSHIFT_ACCOUNT_KEY"} or
               key.endswith(("_SEED", "_WSS", "_URL"))}
    if len(private) > 100:
        raise RuntimeError("Too many private runtime settings for one deployment")
    lines = ["      - " + json.dumps(f"{key}={('ac-secret://' + key) if key in private else settings[key]}")
             for key in sorted(settings)]
    return template.replace("      - MARKET_MAKER=1", "      - MARKET_MAKER=1\n" + "\n".join(lines)), private


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--create", action="store_true")
    operation.add_argument("--update", metavar="DSEQ")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        raise RuntimeError("Use a full verified commit SHA")
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(PRIVATE, 0o700)
    settings = runtime_settings()
    secret_path = PRIVATE / "secrets.json"
    secret_path.write_text(json.dumps(settings))
    os.chmod(secret_path, 0o600)
    template = (Path(__file__).parent / "deploy.yaml").read_text()
    template = template.replace("RENDER_FULL_COMMIT_SHA", args.revision)
    template, native_secrets = render_environment(template, settings)
    sdl_path = PRIVATE / "deploy.yaml"
    sdl_path.write_text(template)
    os.chmod(sdl_path, 0o600)
    print("Rendered pinned SDL with secret references; no cloud deployment yet", flush=True)
    if args.create or args.update:
        command = ["akt", "console", "deployment"] + (["create", str(sdl_path), "--yes"] if args.create else ["update", args.update, str(sdl_path)])
        command += ["--secrets-file", "-", "-o", "json"]
        credentials = dotenv(ROOT / ".env")
        cli_env = dict(os.environ)
        if credentials.get("AKT_CONSOLE_API_KEY"):
            cli_env["AKT_CONSOLE_API_KEY"] = credentials["AKT_CONSOLE_API_KEY"]
        result = subprocess.run(command, input=json.dumps(native_secrets), text=True, capture_output=True, env=cli_env)
        # CLI errors can embed request payloads. Never print raw response bodies.
        if result.returncode:
            failure = PRIVATE / "last-command-error.json"
            failure.write_text(json.dumps({"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}))
            failure.chmod(0o600)
            raise RuntimeError("CLI returned an error. The remote mutation may already have succeeded. Inspect remote state and the private operator response before retrying.")
        payload = json.loads(result.stdout)
        response = PRIVATE / ("create-response.json" if args.create else "update-response.json")
        response.write_text(json.dumps(payload))
        os.chmod(response, 0o600)
        print("Backend deployment order created; inspect its bids before accepting a lease" if args.create else "Backend deployment updated to the pinned revision", flush=True)


if __name__ == "__main__":
    main()

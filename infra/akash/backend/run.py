"""Single backend replica, persistent state, private service ports, explicit activation."""
from __future__ import annotations

import os
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
DATA = Path(os.environ.get("MOONSHIFT_DATA", "/data"))
STATE = DATA / "state"
SERVICES = [("pricing", "app.main:app", 6100), ("risk", "app.main:app", 7000),
            ("credit", "credit.main:app", 7100), ("compute", "compute.main:app", 5000),
            ("router", "router.main:app", 7200)]


def persist(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        source.unlink()
    elif source.exists():
        if not destination.exists():
            shutil.move(str(source), str(destination))
        elif source.is_dir():
            shutil.rmtree(source)
        else:
            source.unlink()
    if not destination.exists() and source.suffix not in {".db", ".json"}:
        destination.mkdir(parents=True)
    source.parent.mkdir(parents=True, exist_ok=True)
    source.symlink_to(destination, target_is_directory=destination.is_dir())


def main() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    # Deployment remains inert until the operator has transferred a consistent
    # snapshot and stopped the previous API. No second keeper or ledger writer.
    print("Waiting for state migration and activation", flush=True)
    while not (STATE / "ACTIVATE").exists():
        time.sleep(2)
    # An update may briefly create a replacement container. The persistent
    # volume lock lets only one replica start API jobs and sign transactions.
    with (STATE / "backend.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run_locked()


def run_locked() -> None:
    manifest_bytes = (STATE / "migration.json").read_bytes()
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    manifest = json.loads(manifest_bytes)
    if not manifest.get("sourceStopped") or not manifest.get("files"):
        raise RuntimeError("A completed state migration is required")
    for required in ("api/moonshift.db", "router/router.db", "credit/credit.db",
                     "contracts/accounts.devnet.json", "contracts/lending.devnet.json", "contracts/collateral.devnet.json"):
        if not (STATE / required).is_file():
            raise RuntimeError("Missing migrated state: " + required)
        if required not in manifest["files"]:
            raise RuntimeError("Migrated state is missing from the manifest: " + required)
    # Verify the initial snapshot once. Subsequent restarts preserve mutations
    # made by this backend instead of comparing them to yesterday's snapshot.
    verified = STATE / "migration-verified"
    if not verified.exists() or verified.read_text() != manifest_digest:
        for relative, digest in manifest["files"].items():
            target = (STATE / relative).resolve()
            if not target.is_relative_to(STATE.resolve()) or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise RuntimeError("State snapshot integrity check failed")
        verified.write_text(manifest_digest)
        verified.chmod(0o600)
    for required in ("INTERNAL_API_KEY", "ADMIN_KEY", "MOONSHIFT_ACCOUNT_KEY"):
        if not os.environ.get(required):
            raise RuntimeError(f"Missing required runtime setting: {required}")
    if os.environ.get("NETWORK") != "devnet" or os.environ.get("MOCK_XRPL") != "0":
        raise RuntimeError("Release requires the configured live development ledger")
    persist(ROOT / "apps/api/moonshift.db", STATE / "api/moonshift.db")
    persist(ROOT / "services/router/data", STATE / "router")
    persist(ROOT / "services/credit/data", STATE / "credit")
    persist(ROOT / "services/compute/.state", STATE / "compute")
    persist(ROOT / "services/risk/.state", STATE / "risk")
    for filename in ("accounts.devnet.json", "lending.devnet.json", "collateral.devnet.json", "active_loans.json"):
        persist(ROOT / "contracts" / filename, STATE / "contracts" / filename)
    env = {**os.environ, "API_URL": "http://127.0.0.1:4000", "COMPUTE_URL": "http://127.0.0.1:5000",
           "PRICING_URL": "http://127.0.0.1:6100", "RISK_URL": "http://127.0.0.1:7000",
           "CREDIT_URL": "http://127.0.0.1:7100", "ROUTER_URL": "http://127.0.0.1:7200",
           "MOCK": "0", "FLEET_SOURCE": "own", "PRICE_SOURCES": "aws_public",
           "STATE_BACKEND": "local", "QUEUE_BACKEND": "local", "ORCHESTRATOR": "local",
           "SETTLEMENT": "api", "KEEPER_DRY_RUN": "1", "DEMO_SHOCK_ENABLED": "0",
           "BEDROCK_ENABLED": "0", "BEDROCK_EXPLAIN": "0", "NODE_OPTIONS": "--dns-result-order=ipv4first"}
    env.update({f"MOCK_{name}": "0" for name in ("COMPUTE", "PRICING", "RISK", "CREDIT", "ROUTER")})
    children: list[subprocess.Popen] = []
    logs = []

    def stop(*_args):
        for child in reversed(children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for child in reversed(children):
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)
        for log in logs:
            log.close()

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    try:
        for name, module, port in SERVICES:
            log = (DATA / "logs" / f"{name}.log").open("ab")
            logs.append(log)
            python = DATA / "venvs" / os.environ["MOONSHIFT_REVISION"] / name / "bin/python"
            children.append(subprocess.Popen([str(python), "-m", "uvicorn", module, "--host", "127.0.0.1", "--port", str(port)],
                                             cwd=ROOT / "services" / name, env=env, stdout=log, stderr=log, start_new_session=True))
        deadline = time.monotonic() + 120
        pending = {name: port for name, _, port in SERVICES}
        while pending and time.monotonic() < deadline:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("A backend dependency exited during startup")
            for name, port in list(pending.items()):
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                        if response.status == 200:
                            del pending[name]
                except Exception:
                    pass
            time.sleep(1)
        if pending:
            raise RuntimeError("Backend dependency readiness timed out: " + ", ".join(pending))
        log = (DATA / "logs/api.log").open("ab")
        logs.append(log)
        children.append(subprocess.Popen(["node", "--import", "tsx", "apps/api/src/index.ts"], cwd=ROOT,
                                         env={**env, "PORT": "4000"}, stdout=log, stderr=log, start_new_session=True))
        deadline = time.monotonic() + 90
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("A backend process exited during API startup")
            try:
                with urlopen("http://127.0.0.1:4000/health", timeout=2) as response:
                    if response.status == 200:
                        break
            except Exception:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError("API readiness timed out")
            time.sleep(1)
        print(f"Backend started at revision {os.environ['MOONSHIFT_REVISION']}", flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(2)
        raise RuntimeError("A backend process exited; restarting the complete backend")
    finally:
        stop()


if __name__ == "__main__":
    main()

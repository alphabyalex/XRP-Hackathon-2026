"""Capture consistent databases and mutable service state after stopping the source.

The archive is private operational data. It must never be committed or logged.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-stopped", action="store_true", required=True)
    args = parser.parse_args()
    # Check listeners, not just the stack supervisor PID. Stale grandchildren
    # must not remain active while a snapshot is handed to a new writer.
    for port in (4000, 5000, 5001, 6100, 7000, 7001, 7100, 7200):
        check = subprocess.run(["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], text=True, capture_output=True)
        for pid in check.stdout.split():
            cmd = subprocess.run(["ps", "-p", pid, "-o", "command="], text=True, capture_output=True).stdout
            if "ControlCenter" not in cmd and cmd.strip():
                raise RuntimeError(f"A source service still listens on port {port}")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    private = Path.home() / ".local/state/moonshift/backend" / stamp
    state = private / "state"
    state.mkdir(parents=True, mode=0o700)
    os.chmod(private, 0o700)
    for source, relative in (("apps/api/moonshift.db", "api/moonshift.db"),
                             ("services/router/data/router.db", "router/router.db"),
                             ("services/credit/data/credit.db", "credit/credit.db")):
        if not (ROOT / source).is_file():
            raise RuntimeError("Required source database is missing: " + source)
        destination = state / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(f"file:{ROOT / source}?mode=ro", uri=True)) as old, closing(sqlite3.connect(destination)) as new:
            old.backup(new)
            if new.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Database integrity check failed")
            new.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # A closed backup can retain empty macOS WAL/SHM sidecars. The main
        # backup has been checkpointed; remove only its transient sidecars.
        for suffix in ("-wal", "-shm"):
            Path(str(destination) + suffix).unlink(missing_ok=True)
    for source, relative in (("services/compute/.state", "compute"), ("services/risk/.state", "risk"),
                             ("services/router/data", "router"), ("services/credit/data", "credit")):
        if (ROOT / source).exists():
            shutil.copytree(ROOT / source, state / relative, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("*.db", "*.db-wal", "*.db-shm", "*.log", "__pycache__"))
    for filename in ("accounts.devnet.json", "lending.devnet.json", "collateral.devnet.json", "active_loans.json"):
        source = ROOT / "contracts" / filename
        if filename != "active_loans.json" and not source.exists():
            raise RuntimeError("Required source contract state is missing: " + filename)
        if source.exists():
            (state / "contracts").mkdir(exist_ok=True)
            shutil.copy2(source, state / "contracts" / filename)
    files = {str(path.relative_to(state)): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in state.rglob("*") if path.is_file()}
    (state / "migration.json").write_text(json.dumps({"capturedAt": stamp, "sourceStopped": True, "files": files}, indent=2))
    archive = private / "snapshot.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(state, arcname="state")
    os.chmod(archive, 0o600)
    print(str(archive))


if __name__ == "__main__":
    main()

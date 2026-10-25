"""Deployment safety tests using temporary state and stubbed backend processes only."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]
REVISION = "a" * 40
FIXTURE_ENV = {
    "INTERNAL_API_KEY": "unit-test-only",
    "ADMIN_KEY": "unit-test-only",
    "MOONSHIFT_ACCOUNT_KEY": "0" * 64,
    "MOONSHIFT_REVISION": REVISION,
    "NETWORK": "devnet",
    "MOCK_XRPL": "0",
}
DATABASES = ("api/moonshift.db", "router/router.db", "credit/credit.db")
CONTRACTS = ("accounts.devnet.json", "lending.devnet.json", "collateral.devnet.json")


def load(name):
    spec = importlib.util.spec_from_file_location(f"deployment_test_{name}", BACKEND / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def migrated_state(root):
    state = root / "volume/state"
    (root / "volume/logs").mkdir(parents=True)
    state.mkdir()
    for relative in DATABASES:
        path = state / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE fixture(value INTEGER)")
    for name in CONTRACTS:
        path = state / "contracts" / name
        path.parent.mkdir(exist_ok=True)
        path.write_text("{}")
    files = {str(path.relative_to(state)): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in state.rglob("*") if path.is_file()}
    (state / "migration.json").write_text(json.dumps({"sourceStopped": True, "files": files}))
    (state / "ACTIVATE").touch()
    return state


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="moonshift-deployment-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.module = load("run")
        self.state = migrated_state(self.root)
        self.module.ROOT = self.root / "release"
        self.module.DATA = self.root / "volume"
        self.module.STATE = self.state

    def test_missing_or_changed_snapshot_never_starts_a_writer(self):
        manifest = self.state / "migration.json"
        original = manifest.read_bytes()
        (self.state / "migration-verified").write_text(hashlib.sha256(original).hexdigest())
        changed = json.loads(original)
        changed["capturedAt"] = "new-snapshot"
        manifest.write_text(json.dumps(changed))
        (self.state / "contracts/accounts.devnet.json").write_text('{"corrupted":true}')
        with patch.object(self.module.subprocess, "Popen") as spawn, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "integrity"):
                self.module.main()
            spawn.assert_not_called()
        manifest.unlink()
        with patch.object(self.module.subprocess, "Popen") as spawn, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(FileNotFoundError):
                self.module.main()
            spawn.assert_not_called()

    def test_persistent_destination_survives_redeploy_and_writes(self):
        destination = self.root / "volume/state/contracts/held.json"
        destination.write_text("operator-state")
        source = self.root / "release/contracts/held.json"
        source.parent.mkdir(parents=True)
        source.write_text("repository-default")
        self.module.persist(source, destination)
        self.assertTrue(source.is_symlink())
        self.assertEqual(destination.read_text(), "operator-state")
        source.write_text("updated-state")
        self.module.persist(source, destination)
        self.assertEqual(destination.read_text(), "updated-state")

    def test_existing_volume_writer_fences_replacement_until_lock_released(self):
        started, launched = self.root / "started", self.root / "launched"
        script = f"""
import importlib.util,pathlib
spec=importlib.util.spec_from_file_location('supervisor',{str(BACKEND / 'run.py')!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=pathlib.Path({str(self.root / 'release')!r})
m.DATA=pathlib.Path({str(self.root / 'volume')!r});m.STATE=m.DATA/'state'
def forbidden_process(*args,**kwargs):
 pathlib.Path({str(launched)!r}).touch()
 raise SystemExit(0)
m.subprocess.Popen=forbidden_process
pathlib.Path({str(started)!r}).touch()
m.main()
"""
        with (self.state / "backend.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            child = subprocess.Popen([sys.executable, "-c", script], env=FIXTURE_ENV,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(started.exists())
                time.sleep(0.15)
                self.assertFalse(launched.exists())
                fcntl.flock(lock, fcntl.LOCK_UN)
                _, error = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, error.decode())
                self.assertTrue(launched.exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    def test_shutdown_handles_exit_race_and_reaps_killed_api_group(self):
        children, health, signals = [], [], []

        class Process:
            def __init__(process, args, **kwargs):
                self.assertTrue(kwargs["start_new_session"])
                process.args = args
                process.pid = 1000 + len(children)
                process.waits = 0
                children.append(process)

            def poll(process):
                return None

            def wait(process, timeout):
                process.waits += 1
                if process is children[-1] and process.waits == 1:
                    raise subprocess.TimeoutExpired("test-api", timeout)
                return 0

        class Healthy:
            status = 200

            def __enter__(response):
                return response

            def __exit__(response, *args):
                pass

        def get_health(url, timeout):
            health.append(url)
            return Healthy()

        def kill_group(pid, sig):
            signals.append((pid, sig))
            if pid == 1002 and sig == signal.SIGTERM:
                raise ProcessLookupError("Already exited fixture group")

        def sleep(seconds):
            if len(children) == 6:
                raise SystemExit(0)

        with patch.dict(os.environ, FIXTURE_ENV, clear=True), \
                patch.object(self.module.subprocess, "Popen", Process), \
                patch.object(self.module, "urlopen", get_health), \
                patch.object(self.module.time, "sleep", sleep), \
                patch.object(self.module.signal, "signal", lambda *args: None), \
                patch.object(self.module.os, "killpg", kill_group), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.module.main()
        self.assertEqual(health[-1], "http://127.0.0.1:4000/health")
        self.assertEqual(children[-1].args[:3], ["node", "--import", "tsx"])
        self.assertEqual([pid for pid, sig in signals if sig == signal.SIGTERM],
                         [process.pid for process in reversed(children)])
        self.assertIn((children[-1].pid, signal.SIGKILL), signals)
        self.assertEqual(children[-1].waits, 2)
        self.assertTrue(all(process.waits for process in children))


class SnapshotTests(unittest.TestCase):
    def test_snapshot_captures_committed_wal_and_private_mutable_state(self):
        module = load("snapshot")
        with tempfile.TemporaryDirectory(prefix="moonshift-snapshot-test-") as temp:
            root = Path(temp)
            module.ROOT = root / "source"
            connections = []
            try:
                for relative in ("apps/api/moonshift.db", "services/router/data/router.db", "services/credit/data/credit.db"):
                    path = module.ROOT / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    db = sqlite3.connect(path)
                    connections.append(db)
                    db.execute("PRAGMA journal_mode=WAL")
                    db.execute("PRAGMA wal_autocheckpoint=0")
                    db.execute("CREATE TABLE fixture(value INTEGER)")
                    db.execute("INSERT INTO fixture VALUES(42)")
                    db.commit()
                    self.assertTrue(Path(str(path) + "-wal").exists())
                for name in CONTRACTS:
                    path = module.ROOT / "contracts" / name
                    path.parent.mkdir(exist_ok=True)
                    path.write_text('{"publicState":"preserved"}')
                pending = module.ROOT / "services/compute/.state/bookings.json"
                pending.parent.mkdir(parents=True)
                pending.write_text('{"held":true}')
                (module.ROOT / ".env").write_text("DO_NOT_COPY=fixture-only")
                output = io.StringIO()
                with patch.object(module.Path, "home", return_value=root / "private-home"), \
                        patch.object(module.subprocess, "run", return_value=SimpleNamespace(stdout="", returncode=1)), \
                        patch.object(sys, "argv", ["snapshot.py", "--source-stopped"]), \
                        contextlib.redirect_stdout(output):
                    module.main()
                archive = Path(output.getvalue().strip())
                state = archive.parent / "state"
                self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
                for relative in DATABASES:
                    with sqlite3.connect(state / relative) as db:
                        self.assertEqual(db.execute("SELECT value FROM fixture").fetchone(), (42,))
                        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual((state / "compute/bookings.json").read_text(), '{"held":true}')
                with tarfile.open(archive) as tar:
                    names = tar.getnames()
                unexpected = [name for name in names if name.endswith(("-wal", "-shm", ".env"))]
                self.assertFalse(unexpected, unexpected)
                manifest = json.loads((state / "migration.json").read_text())
                self.assertTrue(manifest["sourceStopped"])
                self.assertTrue(all(f"contracts/{name}" in manifest["files"] for name in CONTRACTS))
            finally:
                for db in connections:
                    db.close()

    def test_snapshot_refuses_a_listening_ledger_writer(self):
        module = load("snapshot")

        def process(args, **kwargs):
            return SimpleNamespace(stdout="9999\n" if args[0] == "lsof" else "node apps/api/src/index.ts\n")

        with patch.object(module.subprocess, "run", process), \
                patch.object(sys, "argv", ["snapshot.py", "--source-stopped"]):
            with self.assertRaisesRegex(RuntimeError, "still listens"):
                module.main()


if __name__ == "__main__":
    unittest.main()

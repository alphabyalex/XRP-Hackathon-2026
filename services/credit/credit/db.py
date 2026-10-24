"""SQLite storage: raw XRPL response cache, plus watchlist and mainnet link proofs."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from credit import config as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_cache (
  key TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  params TEXT NOT NULL,
  response TEXT NOT NULL,
  fetched_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS watch (
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (network, address)
);
CREATE TABLE IF NOT EXISTS watch_loans (
  loan_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  due_at TEXT NOT NULL,
  principal TEXT,
  repaid INTEGER NOT NULL DEFAULT 0,
  missed_reported INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS link_challenges (
  id TEXT PRIMARY KEY,
  borrower TEXT NOT NULL,
  mainnet_address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  mainnet_address TEXT PRIMARY KEY,
  borrower TEXT NOT NULL,
  public_key TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_links (
  borrower TEXT PRIMARY KEY,
  mainnet_address TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  borrower TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  public_key TEXT,
  verified INTEGER NOT NULL,
  connected_at TEXT NOT NULL
);
"""

# Columns added after the first release; ALTER fails harmlessly once they exist.
MIGRATIONS = ["ALTER TABLE link_challenges ADD COLUMN network TEXT NOT NULL DEFAULT 'mainnet'"]


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            for sql in MIGRATIONS:
                try:
                    self._conn.execute(sql)
                except sqlite3.OperationalError:
                    pass

    def execute(self, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    # ---- raw response cache ----

    def cache_get(self, key: str, ttl_seconds: float | None) -> dict[str, Any] | None:
        rows = self.execute("SELECT response, fetched_at FROM raw_cache WHERE key = ?", (key,))
        if not rows:
            return None
        if ttl_seconds is not None and time.time() - rows[0]["fetched_at"] > ttl_seconds:
            return None
        result: dict[str, Any] = json.loads(rows[0]["response"])
        return result

    def cache_put(
        self,
        key: str,
        network: str,
        source: str,
        method: str,
        params: dict[str, Any],
        response: dict[str, Any],
    ) -> None:
        self.execute(
            "INSERT OR REPLACE INTO raw_cache VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                network,
                source,
                method,
                json.dumps(params, sort_keys=True),
                json.dumps(response),
                time.time(),
            ),
        )

    def cache_clear(self) -> None:
        self.execute("DELETE FROM raw_cache")


_store: Store | None = None


def store() -> Store:
    global _store
    if _store is None:
        _store = Store(C.DB_PATH)
    return _store

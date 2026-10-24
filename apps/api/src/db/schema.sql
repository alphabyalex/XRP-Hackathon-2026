-- apps/api SQLite schema. Run automatically on startup (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS usage_events (
  request_id TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  buyer TEXT NOT NULL,
  booking_id TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  charge TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS revenue_ledger (
  id TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('inference','contract')),
  amount TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL,
  dividend_run_id TEXT
);

CREATE TABLE IF NOT EXISTS dividend_runs (
  id TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross_revenue TEXT NOT NULL,
  hosting_fee TEXT NOT NULL,
  reserve TEXT NOT NULL,
  distributable TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','paid','failed')),
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  dividend_run_id TEXT NOT NULL,
  account TEXT NOT NULL,
  amount TEXT NOT NULL,
  tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  qty TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slots INTEGER NOT NULL,
  tx_hash TEXT,
  booking_id TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  holder TEXT NOT NULL,
  redemption_id TEXT
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  borrower TEXT NOT NULL,
  gpu_id TEXT NOT NULL,
  collateral_shares TEXT NOT NULL,
  principal TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','repaid','defaulted')),
  escrow_tx TEXT,
  disburse_tx TEXT,
  settle_tx TEXT
);

CREATE TABLE IF NOT EXISTS tx_log (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account TEXT NOT NULL,
  summary TEXT NOT NULL,
  explorer_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holders_cache (
  gpu_id TEXT NOT NULL,
  account TEXT NOT NULL,
  shares TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (gpu_id, account)
);

CREATE TABLE IF NOT EXISTS inference_credits (
  buyer TEXT PRIMARY KEY,
  balance TEXT NOT NULL DEFAULT '0'
);

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

-- XLS-66 loans (devnet lending). One row per loan; ledger state is read live.
CREATE TABLE IF NOT EXISTS xls_loans (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  borrower TEXT NOT NULL,
  borrower_address TEXT NOT NULL,
  gpu_id TEXT NOT NULL,
  collateral_shares TEXT NOT NULL,
  principal TEXT NOT NULL,
  apr TEXT NOT NULL,
  margin_call_ltv TEXT NOT NULL,
  liquidation_ltv TEXT NOT NULL,
  pd TEXT NOT NULL,
  round INTEGER NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  margin_call_at TEXT,
  liquidated_at TEXT,
  default_eligible_at TEXT,
  txs TEXT NOT NULL DEFAULT '{}',
  quote_id TEXT,
  simulated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loan_quotes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  body TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oracle_history (
  gpu_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  price TEXT NOT NULL,
  source TEXT NOT NULL,
  tx_hash TEXT,
  PRIMARY KEY (gpu_id, ts)
);

CREATE TABLE IF NOT EXISTS keeper_actions (
  idempotency_key TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tx_hash TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Moonshift accounts: one per connected wallet. The devnet seed is encrypted
-- at rest (AES-256-GCM, key MOONSHIFT_ACCOUNT_KEY in .env); never logged or returned.
CREATE TABLE IF NOT EXISTS users (
  wallet_address TEXT PRIMARY KEY,
  wallet_network TEXT NOT NULL,
  account_address TEXT NOT NULL UNIQUE,
  seed_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  setup_ms INTEGER
);

-- Funded, ready accounts handed out on first connect (instant sign-up).
-- Accounts an operator reset took away from their wallet (kept: they stay on the ledger).
CREATE TABLE IF NOT EXISTS retired_accounts (
  account_address TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  seed_enc TEXT NOT NULL,
  retired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_pool (
  account_address TEXT PRIMARY KEY,
  seed_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  setup TEXT NOT NULL
);

-- Signed-in browsers: sha256 of the httpOnly cookie token.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- GPU share prices: trades the api executed (fill price from the ledger) and
-- the price shown over time (DEX midpoint, last trade or oracle NAV).
CREATE TABLE IF NOT EXISTS share_trades (
  hash TEXT PRIMARY KEY,
  gpu_id TEXT NOT NULL,
  price TEXT NOT NULL,
  qty TEXT NOT NULL,
  side TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS share_prices (
  gpu_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  price TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (gpu_id, ts)
);

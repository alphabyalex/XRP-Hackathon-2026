# Lucy status (services/credit, Quicknode)

## Done
- Phase 0: verified Quicknode XRPL support from their docs, wrote docs/QUICKNODE.md.
- Phase 1: contracts in contracts/credit (profile, profiles_batch, events_sse,
  credit_events_internal, watch, streams_webhook, explain, link). FastAPI
  skeleton in services/credit with GET /health, GET /profile/{network}/{address},
  POST /profiles, GET /events (SSE). MOCK=1 (default) returns the contract
  examples labeled simulated. pytest, mypy and ruff pass.
- Phase 2: read-only JSON-RPC client (credit/xrpl_client.py): account_info,
  account_lines and account_tx (newest first, follows the marker, stops at
  ACCOUNT_TX_MAX_PAGES and reports truncated), plus first_tx for account age.
  Raw responses cached in SQLite (credit/db.py), keyed by network, source,
  method and params. Backoff with retry on HTTP 429/5xx and rippled
  slowDown/tooBusy, honoring Retry-After. Only read methods are allowed, so
  the client cannot submit a transaction. Smoke-tested live against public
  testnet and mainnet.

- Phase 3: features (credit/features.py), points scorecard with weights in
  services/credit/scorecard.json (credit/scoring.py), live profiles wired into
  GET /profile and POST /profiles. Moonshift loan history is read from the
  packages/xrpl memos and escrows. Required tests pass: old active beats new
  empty, a liquidation lowers the score, the same input (any order) gives the
  same score. Live check on public endpoints: testnet ALICE scores 56/C (3
  real on-time Moonshift repayments, thin file because testnet reset today);
  mainnet genesis account scores 74/B, high confidence.

## Next
- Phase 4: mainnet read-only mode and signed-message proof of ownership.

## Blockers
- No `.env` in the repo yet, so `QUICKNODE_XRPL_MAINNET_URL` and
  `QUICKNODE_XRPL_TESTNET_URL` are unset. The service falls back to public
  XRPL endpoints and labels every response `source: "public"` until a human
  adds them.

## Decisions
- Live monitoring uses Quicknode Streams as the primary path (Lucy's call):
  ledger dataset, a JS filter that checks a Quicknode Key-Value Store
  watchlist, delivered to the credit service's signed webhook receiver. A
  Quicknode WebSocket `subscribe` on `accounts` is the fallback
  (`MONITOR_MODE=websocket`) if Streams is not on our plan.
- Followed the Lucy prompt's branch rule (commit and push to `lucy`) over the
  root CLAUDE.md, which is written for Alexander's own session (`alex` branch).
- Contract JSON uses camelCase (address, readOnly, asOf), matching apps/api.
  XRP amounts in profiles are XRP decimal strings with 6 decimals.
- Mock tx hashes are obvious placeholders (000...001) so nobody mistakes them
  for real transactions.
- Cache TTL is 15 minutes for latest data (account_info, first account_tx
  page). Older account_tx pages and the oldest-tx lookup never change, so they
  are cached forever. `?refresh=1` re-fetches the latest data.
- History depth is capped at 10 pages of 200 (2,000 newest txs) to stay well
  under the free-plan credit budget; profiles say `truncated: true` when hit.
- Legacy memos: testnet loans made before the rename carry GB_REPAY,
  GB_LOAN_DISBURSE, GB_DIVIDEND. They are read as their MS_ equivalents
  (original kept in legacyType). Without this, ALICE's three repaid loans
  looked overdue.
- Loan due time comes from the collateral escrow's CancelAfter minus the
  120 s grace packages/xrpl adds. A repayment whose loan escrow is outside the
  fetched history counts as on time (no evidence of lateness). An unrepaid,
  unliquidated loan past due counts in msRepaysLate.
- A liquidation is an EscrowFinish by someone else on a borrower-owned escrow
  that matches a loan escrow's Sequence, or any such finish by LENDING_POOL.
- Native XLS-66 loan transactions (LoanSet, LoanPay, ...) are not scored yet,
  because packages/xrpl currently uses escrow plus memos. Add them once Alex's
  XLS-66 flow is on main.
- Public endpoints are paced at 1 request per second (Quicknode at 15 rps).
  Public mainnet threw tooBusy/slowDown on a burst of paged account_tx. That
  is a concrete reason the Quicknode endpoint matters, noted in docs/QUICKNODE.md.
- The service loads services/credit/.env, then the repo root .env, without
  ever printing them. Tests blank the Quicknode vars so they never hit the network.

# Lucy status (services/credit, Quicknode)

## Done
- Phase 0: verified Quicknode XRPL support from their docs, wrote docs/QUICKNODE.md.
- Phase 1: contracts in contracts/credit (profile, profiles_batch, events_sse,
  credit_events_internal, watch, streams_webhook, explain, link). FastAPI
  skeleton in services/credit with GET /health, GET /profile/{network}/{address},
  POST /profiles, GET /events (SSE). MOCK=1 (default) returns the contract
  examples labeled simulated. pytest, mypy and ruff pass.

## Next
- Phase 2: JSON-RPC fetch (account_info, account_lines, paged account_tx) with
  SQLite cache and backoff on rate limits.

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
- The service loads services/credit/.env, then the repo root .env, without
  ever printing them. Tests blank the Quicknode vars so they never hit the network.

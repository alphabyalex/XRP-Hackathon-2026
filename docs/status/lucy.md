# Lucy status

# Order router (services/router, port 7200)

## Done
- Phase 0: verified every price and availability source (AWS Price List,
  Spot price history, placement scores, instance type and Capacity Block
  offerings, Spot Advisor, Azure Retail Prices, GCP Billing Catalog, Oracle
  price list, Lambda, RunPod, Vast.ai) and their interruption warnings.
  docs/ROUTER_PROVIDERS.md. Real responses from the 5 sources that need no
  account saved as mock fixtures in services/router/router/collectors/fixtures.

## Next
- Phase 1: offer catalog, fleet, interruption model, contracts.

## Blockers
- No AWS credentials on this machine (no AWS CLI either). All AWS adapters
  run in MOCK until AWS_PROFILE (or an EC2 role) is available.
- GCP Billing Catalog needs an API key; Lambda needs an API key. Both go in
  Secrets Manager secret moonshift/router/providers (filled by a human).
- No BRAND.md in the repo or on disk; UI follows packages/shared/src/brand.ts
  and apps/web/app/globals.css plus the prompt's rules.

## Decisions
- Prompt v2 (multi-provider, AWS control plane) replaced v1 before anything
  was committed. Differences from v1: an offer catalog across AWS, Azure, GCP,
  Oracle and marketplaces (not just a fixed fleet); price collectors as
  Lambda-ready functions on EventBridge Scheduler with DynamoDB + S3; SAM
  template in services/router/infra; DynamoDB leases, Step Functions per order,
  SQS dispatch per tier, EventBridge interruption events; settlement changed
  from "buyer pays each GPU" to "buyer pays the order treasury, router settles
  each GPU for work actually served (MS_SETTLE) and refunds the rest";
  checkpoints in DynamoDB (S3 over 350 KB); CloudWatch, cost tags, CUR join;
  /admin/router shows the live catalog. Kept from v1: contracts/router drafts
  and config/fleet.json, revised in Phase 1.
- Google Cloud Spot notice is 0 s by default (not 30 s); GCP workers must be
  created with a 120 s preemption notice. Catalog default for GCP: 30 s.
- RunPod is priced on-demand only (spot warning window not documented).

---

# Credit service (services/credit, Quicknode)

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

- Phase 4: mainnet profiles are `readOnly: true`, `network: mainnet`, and
  the XRPL client has no submit path at all (only read methods allowed, tested).
  Stretch done: POST /link/challenge and POST /link/verify prove a borrower
  controls a mainnet address with an off-ledger signed message checked by
  xrpl-py (master key, or the account's RegularKey read via account_info).
  Verified mainnet profiles carry `ownership`. GET /links/{borrower} lists
  linked addresses. scripts/sign_link.py signs a challenge offline for the demo.

- Phase 5: live monitoring. Quicknode Streams is the primary path: JS filter
  (services/credit/quicknode/streams_filter.js, tested in Node with a stubbed
  qnLib) reads the Quicknode KV watchlist; signed receiver POST /streams/xrpl
  (HMAC checked, gzip ok, filtered or raw ledger payloads). Classifier emits
  LARGE_OUTFLOW, MS_LOAN_DISBURSE, MS_REPAY, MARGIN_CALL, LIQUIDATION and
  MISSED_PAYMENT (15 s overdue check) to GET /events and api
  POST /internal/credit-events. POST/DELETE/GET /watch keeps the KV list in
  sync. WebSocket fallback (MONITOR_MODE=websocket) smoke-tested live on
  public testnet. POST /monitor/simulate for rehearsals, labeled simulated.
  Requests for Alex and Kristian added at the bottom of docs/CONTRACTS.md.

- Phase 6: every live profile carries `portfolio` ("borrowers in this grade
  defaulted X% (simulated)") from risk GET /book/stats?grade= (2 s timeout,
  60 s cache), falling back to a mock table labeled `source: "mock"`.
  Expected risk shape in contracts/credit/risk_book_stats.json.

- Phase 7: docs/QUICKNODE.md has a judges' summary (which Quicknode products,
  for what, why) and a reproduce-it section; services/credit/README.md has
  run steps, every env var, all endpoints and the full scorecard table
  generated from scorecard.json.
- Stretch 1: GET /explain/{network}/{address}, the top three positive and
  negative factors with their tx hashes, computed from the same profile.

- Stretch 2: two new scorecard features, msDividendsReceived (MS_DIVIDEND
  payments) and msShareTrades (OfferCreate on GPA/GPB/HRA/HRB); scorecard
  version 2026-10-24.2. Live on testnet ALICE: 4 on-time repayments, 5
  dividends, 4 share trades; raw 61, capped to 60 (C, low) by the thin-file
  rule because the account was funded today after the testnet reset.

## Next
- Improve tests and docs. Then, once a human sets the Quicknode env vars:
  re-run the live checks with source "quicknode" and set up the Stream.

## Blockers
- Streams needs a human in the Quicknode dashboard: create the Stream, paste
  the filter, set the webhook URL, copy the security token into
  `QUICKNODE_STREAMS_TOKEN`, and set `QUICKNODE_API_KEY` for the watchlist.
  Steps in docs/QUICKNODE.md section 4. Also needs a public URL for the credit
  service (EC2 or a tunnel). Until then MONITOR_MODE=websocket works.
- Open question (Lucy): does the dashboard offer XRPL Devnet for endpoints and
  Streams? Quicknode's docs list only Mainnet and Testnet. If yes, set
  STREAMS_NETWORK=devnet and QUICKNODE_XRPL_DEVNET_URL; no code change needed.
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
- Streams receiver is network agnostic (delivery metadata, else
  STREAMS_NETWORK, default testnet), and devnet uses Quicknode when
  QUICKNODE_XRPL_DEVNET_URL is set, so the devnet question is config only.
- One KV list for all networks (an r-address is the same string on every
  network); the receiver checks the watch table per network.
- Margin calls are only visible on-ledger if someone writes an MS_MARGIN_CALL
  memo; requested in docs/CONTRACTS.md.
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

## Round 2 (finished by Alex, 2026-10-24)

Lucy's round 2 (lunch_prompts/Lucy_prompt_2.md, Jobs 1 to 4) was finished by Alex on the alex branch while Lucy was away. See docs/QUICKNODE.md (pitch, click path, ALICE's combined profile, live evidence) and contracts/credit/stats.json.


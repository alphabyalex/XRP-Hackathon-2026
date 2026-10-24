# Lucy status

# Order router (services/router, port 7200)

## Done
- Phase 0: verified every price and availability source (AWS Price List,
  Spot price history, placement scores, instance type and Capacity Block
  offerings, Spot Advisor, Azure Retail Prices, GCP Billing Catalog, Oracle
  price list, Lambda, RunPod, Vast.ai) and their interruption warnings.
  docs/ROUTER_PROVIDERS.md. Real responses from the 5 sources that need no
  account saved as mock fixtures in services/router/router/collectors/fixtures.
- Phase 1: services/router (Python 3.12, FastAPI, port 7200). Offer catalog
  (router/catalog.py) with collectors for AWS (spot every 5 min: Spot price
  history + placement score + Spot Advisor band; on-demand daily: Price List
  + Capacity Blocks), Azure, GCP, Oracle, Lambda, RunPod, Vast.ai and a static
  CoreWeave table. Mock catalog: 33 offers across 9 providers. Fleet
  (config/fleet.json): 6 executable GPUs across Moonshift, AWS spot, AWS
  on-demand, Azure spot and Vast.ai, mapped onto gpu-a and gpu-b. Live state:
  active jobs and queue wait, reclaims, booked windows from compute's
  calendar. Interruption model in config/interruption_model.json. Contracts:
  quote, orders_create, order, order_events_sse, fleet, catalog, fleet_reclaim,
  aws_events. GET /catalog, GET /fleet, POST /fleet/{id}/reclaim. 21 tests.

- Phase 2: collectors run as plain functions in-process (background task,
  spot every 5 min, providers every 15, on-demand daily) or as the Lambda
  router.lambdas.collect_handler on EventBridge Scheduler. Catalog store:
  SQLite locally, DynamoDB ms-router-catalog (pk provider#region#instanceType,
  sk capacityType) + S3 price history (<provider>/<date>/<time>-<source>.json)
  on AWS. Provider keys from Secrets Manager moonshift/router/providers with
  env fallback (values never logged, tested). Staleness: fresh up to
  CATALOG_MAX_AGE (30 min), last good snapshot (degraded) up to 4x, then
  excluded. boto3 adaptive retries, httpx backoff with jitter.
  services/router/infra/template.yaml (SAM): collector Lambda + 3 ScheduleV2
  schedules, DynamoDB catalog/orders/checkpoints (TTL), S3 price bucket,
  3 tier SQS queues + DLQ, Step Functions order machine
  (statemachine/order.asl.json: pay, SQS waitForTaskToken with heartbeats,
  settle), EventBridge interruption rule -> SQS, forwarder Lambda, Secrets
  Manager secret, least-privilege worker role for EC2 and IAM Roles Anywhere.
  cfn-lint passes with no findings (tested). Live run of the public
  collectors today: Azure 4 offers, Oracle 3, RunPod 6, Vast.ai 23, Spot
  Advisor live. 31 tests.

- Phase 3: router/optimizer.py. Per part: run time, earliest start that
  clears booked windows (plus guard), interruption probability
  1 - exp(-rate x hours), resume cost (resume latency + new worker start + lost
  progress, never zero), cross-provider egress (checkpoint GB x egress price),
  expected cost and ETA. Enumerates every split over up to 3 GPUs on a
  12-step share grid (a single streamed reply is never split). Cheapest = min
  cost s.t. deadline and budget; Fastest = min ETA s.t. budget; Balanced =
  Pareto frontier, min-max normalized, closest to (0,0). POST /quote returns
  all three plus alternativesConsidered, plansEvaluated, catalogAsOf and an
  optional Bedrock "why" (number guard drops sentences with invented numbers).
  All required tests pass (ordering over 40 random orders, booked window,
  deadline, interruptible cheapest, stale/non-executable never chosen,
  cheaper executable provider wins, egress flips the choice). 86 tests.
  scripts/benchmark.py: 1,000 orders; Balanced costs 36.0 USDC vs 73.1 for
  naive round-robin, p50 49 s vs 301 s, p99 1,801 s vs 5,699 s; under 500x
  interruption stress round-robin restarts 10 jobs, every router mode 0.
  Results in docs/ROUTER.md.

- Phase 4: POST /orders (optimize, lease every GPU slot with a conditional
  write: SQLite locally, DynamoDB ms-router-orders on AWS, so two orders can
  never hold one slot), GET /orders, GET /orders/{id}, GET /orders/{id}/events
  (SSE: quoted, paid, running, token, progress, checkpointed, moved,
  completed, settled, failed). Orchestration (router/dispatch.py): local
  in-process tier queues drained fastest first, or SQS (long poll, visibility
  extended while running, delete on completion); ORCHESTRATOR=stepfunctions
  starts one Standard execution per order and the worker reports with its
  task token (heartbeats). Step Lambda router.lambdas.order_step_handler runs
  pay, settle and release. Settlement (router/settle.py): MS_ORDER buyer ->
  PROTOCOL_FEES (order treasury) for the quote; on completion MS_SETTLE to
  TREASURY_GPU_A/B for work each GPU actually served (external capacity: the
  margin to the pool, the provider's cost stays in the order treasury); MS_REFUND
  of the rest. apps/api: new file src/routes/router.ts (public /router/*
  proxy incl. SSE, POST /internal/router/pay signing with packages/xrpl wallets
  and serialized per account, OpenAI-style POST /v1/chat/completions with
  priority) plus 3 mount lines in src/index.ts. Rentals book compute's
  /bookings for Moonshift GPUs (the HRA path), router bookings otherwise.
  Found and fixed: reading an order over HTTP mid-run stripped fields the
  settlement needed (regression test added). 97 tests; api typecheck clean.

- Phase 5: resume, don't restart. services/compute/compute/resume.py (new
  module) + two hooks in Tharun's files: one install() line in main.py and
  GpuSupervisor.set_offline() (3 lines) in scheduler.py. resume.py streams
  token-level SSE (POST /v1/resume/stream), checkpoints every N tokens and at
  the signal, continues a reply on another GPU from prompt + partial answer
  (vLLM continue_final_message; deterministic stream in compute's mock mode),
  admits through the existing scheduler (runway and drain respected), stops
  on POST /v1/resume/interrupt or when its GPU enters DRAINING (booking),
  and polls EC2 IMDS spot/instance-action + rebalance, Azure Scheduled
  Events Preempt and GCP preempted metadata behind opt-in flags. Router: one
  reclaim(gpuId, warningSeconds, reason) for every trigger: manual reclaim,
  booking drain monitor, POST /internal/aws-events (EventBridge Spot warning,
  rebalance = checkpoint only, Capacity Block expiry, capacity reservation
  interruption; both detail-type spellings), SQS consumer for the events
  queue, forwarder Lambda, and reclaims reported by workers in the stream.
  Moves keep the order's constraints, record segments, moves and per-GPU
  usage (api /internal/usage at settlement). Tests: interrupted at exactly
  60% resumes as one continuous reply, no token billed twice, restarts 0;
  cross-provider move (Azure to another provider); documented spot warning
  sample moves the job; rebalance checkpoints without moving; Capacity Block
  expiry; booking drain; rental resume; plus an integration test against the
  real compute service over HTTP. Router 107 tests, compute 17 (13 existing
  + 4 new).

## Next
- Phase 6: checkout UI (three options), order view, developers page,
  /admin/router.

## Blockers
- No AWS credentials on this machine (no AWS CLI either). All AWS adapters
  run in MOCK until AWS_PROFILE (or an EC2 role) is available.
- GCP Billing Catalog needs an API key; Lambda needs an API key. Both go in
  Secrets Manager secret moonshift/router/providers (filled by a human).
- Deploying the router stack needs a human with AWS credentials and
  AWS_DEPLOY=1 approval (creates billable resources):
  `sam build -t services/router/infra/template.yaml && sam deploy --stack-name ms-router --region us-east-2 --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --resolve-s3 --parameter-overrides RouterUrl=<public router URL>`.
  Then fill secret moonshift/router/providers and set STATE_BACKEND=dynamodb,
  PRICES_BUCKET (stack output) on the router.
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
- Moonshift GPUs are listed at 0.25 USDC per hour (their own price, no
  margin), between spot T4s (about 0.17 to 0.20 with margin) and on-demand
  clouds, so idle Moonshift capacity wins Balanced often and Cheapest only
  when spot is scarce. MOONSHIFT_MARGIN = 15% on external capacity.
- Tokens per second per GPU model: T4 = 40 (compute's planning figure), the
  rest scaled by memory bandwidth (config/gpu_perf.json), estimates until
  infra/benchmark.py runs on each card. A request runs on one GPU, so
  multi-GPU instances do not add speed for one reply.
- AWS interruption rate = -ln(1 - f) / 720 h from the Spot Advisor band
  midpoint f, times a placement-score multiplier (0.5 at 9+, 3.0 at 1-2).
- Capacity Block events verified: "Capacity Block Expiration Warning" (40 min
  before the end; instances terminate 10 min later) and "EC2 Capacity
  Reservation Instance Interruption Warning". AWS's samples spell the key
  detail_type there; the receiver accepts detail_type and detail-type.
- Order treasury = PROTOCOL_FEES (no ORDER_TREASURY account exists on
  devnet). It is also the external-capacity treasury, so the provider-cost
  share of external work is recorded but needs no transaction (an account
  cannot pay itself). The buyer never pays more than the quote; if moves make
  the served work dearer, settlement is scaled down and Moonshift absorbs it.
- The pay route builds the Payment itself with packages/xrpl's exported
  client and wallets (getClient, getAccountWallet, getAccountAddress) and the
  same memo encoding as packages/xrpl, because payForInference can only pay a
  GPU treasury and cannot carry MS_ORDER / MS_SETTLE / MS_REFUND or pay a
  buyer back. packages/xrpl itself is unchanged. Payments are capped at
  1,000 TDX, devnet/testnet only (networkName throws otherwise).
- Leases expire (LEASE_SECONDS + planned ETA) so a crashed worker can never
  hold a GPU forever; a move releases the old lease and takes a new one.
- Balanced knee: both axes min-max normalized over the Pareto frontier,
  pick the smallest Euclidean distance to (0, 0); ties by cost, then time,
  then GPU ids. This guarantees Balanced lies between Cheapest and Fastest.
- Without a deadline, Cheapest may wait in a queue or for a booked window
  to clear (waiting is free); a deadline, Balanced and Fastest move the job.
  That is why Cheapest's p99 in the benchmark is long: half the synthetic
  orders have no deadline.
- Resume target in the model: the cheapest other available GPU; egress is
  charged only when that GPU is on another provider. Rental checkpoints are
  2 GB (session snapshot), inference checkpoints 200 KB.
- Benchmark load: arrivals every 150 s on average (about 40% utilization);
  at 20 s the 6-GPU fleet was oversubscribed and every policy queued for hours.
- A fleet entry whose catalog offer is missing or older than CATALOG_MAX_AGE
  stays listed but unavailable (OFFER_MISSING, STALE_PRICE); static-priced
  and Moonshift offers never go stale.

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


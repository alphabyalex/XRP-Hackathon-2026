# Tharun night run

Updated 2026-10-25 04:55 ET. Branch `tharun`.

## Done

- Fetched, fast-forwarded `tharun` to `origin/alex` 6d7c8e4, and pushed.
- P0 fixed and pushed: old vLLM compatibility, continuation through text completions, failed-task full cap refund, no fake provider fallback. Live fresh/resumed GPU-A calls succeeded; compute 25 and router 158 tests initially passed before further truth audit.
- Removed fabricated compute API fallback replies, metrics, bookings and revenue history. Upstream failure returns an explicit unavailable error.
- All new route contracts published before 05:15 under `contracts/compute`: catalog, models, AWS SSE/poll, tasks estimate/quote, bookings/calendar. Routes mounted with one line each in index.ts. API catalog/models/quote smoke passed; quotes max 2ms in ten HTTP calls. Unmeasured model token rates remain null.
- Next rewrites prioritize `NEXT_PUBLIC_API_URL`. Vercel project resumed through its dashboard, verified HTTP 200; no redeploy. Morning tunnel commands and polling/cookie requirements are in docs/VERCEL.md. All prepared Akash manifests name actual Qwen2.5 weights; no lease changed.

## Next

- Truth audit finished: live official AWS prices, one physical GPU, persisted metered revenue only. Final full suites: compute 27, router 165, pricing 26; XRPL 10 passed. Four-workspace typecheck passed after Alex merges.
- Live DEV account inference completed on GPU-A and settled on XRPL: ord_91f946e9, cap 0.000055, charged 0.000007, refund 0.000048. Exact public receipt hashes are in contracts/router/live_gpu_a_settlement.json. No Alexander account transaction was made.
- Restart stack using npm run demo with live compute/router and Bedrock disabled here. Verify routes, direct task and refund behavior.
- Run focused payment failure/idempotency integration and full service suites.
- Commit and push small changes, sync Alex at checkpoints, finish by backend freeze.

## Blockers

- Bedrock is deliberately disabled here. Live /tasks/estimate smoke returned fallback in 2ms with live-rate pricing. Alex must opt in and verify real Haiku once on his machine.
- All 6910 full transcript records were processed locally and the 46 user requests plus final implementation summaries reviewed. Earlier fake-data claims and old branch rules were superseded by this night run.
- Cloudflare Quick Tunnels explicitly do not support SSE. Vercel clients need 2 to 5 second polling over that morning tunnel.

## Requests

- Alex: hide InstantSwitchCard and any Monte Carlo GPU/VRAM/preemption stats in production. Existing engine is a local CPU toy that fabricates path count and adds random latency, and the UI fallback hardcodes 3.12ms. Tharun is disabling its live backend metrics/switch route; it is not verified remote GPU compute. Planned GPU risk switching belongs on Docs only.
- Kristian: make helpers.recordUsage idempotent for revenue (INSERT OR REPLACE currently still addRevenue every call). Tharun removed duplicate API-side recording for booked inference, and unbooked /inference/chat now uses validated router settlement, not unpaid metering. Retry-safe ingestion still belongs to your helper.

- Kristian: full API suite is 58/59; the existing liveIntegration GPU test assumes two READY GPUs. Duplicate/offline GPU-B is now correctly OFFLINE. Update that owned test and remove the gpuHealth mock exception; do not restore fabricated capacity to satisfy the assertion.
- Alex: unsupported fine-tune/render/other execution returns TASK_TYPE_UNAVAILABLE. Current serving endpoint is text inference only; keep planned capabilities on Docs. Utilization series now has t/pct aliases matching your catalog client.
- Alex: your 04:58 price-alignment request is in progress: router own-fleet will use the same GPU Economy median as tasks/catalog; AWS stays comparison only. gpuId (or gpu_id) on chat pins GPU-A. Responses report actual settled charged amount, with estimate and cap separate.

- Kristian: startup issue reproduced: macOS AirPlay and uvicorn can both bind port 5000, and localhost selects AirPlay via IPv6 (HTTP 403) despite uvicorn health passing at 127.0.0.1:5000. scripts/demo.mjs must use 127.0.0.1 for every local spawned service URL, not localhost, and the risk URL passed to credit. Owned compute API and router now normalize IPv4. NODE_OPTIONS=--dns-result-order=ipv4first is a local workaround for other adapters.

- Kristian: `apps/api/src/gpuHealth.ts` still treats GPU-B as healthy without a live endpoint via `MOCK_GPUS`. Remove that exception so only health-checked real endpoints are listed. New catalog/models enforce real health independently.
- Kristian: `scripts/demo.mjs` still registers a fabricated GPU-B. Remove it from production startup; compute/router must not execute fake work.
- Kristian: add `aws` to shared `SseEventType`; Tharun will broadcast real refreshed values from an owned feed module.
- Alex: `apps/web/src/lib/api.ts` must use `/api` in browser and `NEXT_PUBLIC_API_URL` server-side. Direct cross-site tunnel browser requests lose SameSite=Lax wallet sessions. Keep that shared base for every API request, SSE and router client. Correct visible model identity to Qwen2.5-1.5B-Instruct; the existing live endpoint still uses Qwen/Qwen3-1.7B as its wire alias.
- Alex and Lucy: Cloudflare Quick Tunnels do not support SSE. Poll every 2 to 5 seconds as a fallback. Same-origin `/api` is needed for existing SameSite=Lax session cookies; browser calls directly to a different tunnel origin will lose wallet sessions. Morning docs describe configuration.
- Alex: consume booking response `redemptionId` as the inference `bookingId` header/body value; `bookingId` is the scheduler record id. Calendar route returns `{events, blocks}` with real hourly occupancy.
- Alex and Kristian: older revenue rows were fabricated by fixed per-minute multipliers. Compute now journals actual charges; unmetered monetary data will be empty rather than made-up zero. Keep that absence visible.
- Alex: only your agent releases main and demo-safe. Tharun pushes only `tharun`.

## Decisions

- New night-run instructions supersede CLAUDE.md's older alex-only branch rule. Changes and pushes are restricted to `tharun`.
- Missing price, history or location is null/empty with source status; no invented values or backfilled 24-hour series.
- Actual GPU-A weights are Qwen2.5-1.5B-Instruct on Akash T4. The legacy served alias is transport metadata, not a product model claim.
- No Akash lease changes, no AKT spending, no new paid AWS resources and no Vercel deployment tonight.

- Bedrock is opt-in with `BEDROCK_ENABLED=1` on Alex's machine. All Bedrock paths use deterministic fallback here even when unrelated local AWS credentials exist. Pricing tests 26/26 and current four-workspace typecheck pass.

- Read-only Akash saved SDL verification found actual GPU-A storage is 100GiB (not the older node manifest's 50GiB). Catalog, contract and prepared manifest corrected to the verified 4vCPU/16GiB/100GiB. No lease changed.

- Read-only existing provider catalog confirms city=LIS,country=PT,location-region=eu-southwest. Catalog now shows Lisbon (LIS), eu-southwest, Portugal; no location was guessed from a hostname.

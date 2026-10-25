# Tharun night run

Updated 2026-10-25 04:55 ET. Branch `tharun`.

## Done

- Fetched, fast-forwarded `tharun` to `origin/alex` 6d7c8e4, and pushed.
- P0 fixed and pushed: old vLLM compatibility, continuation through text completions, failed-task full cap refund, no fake provider fallback. Live fresh/resumed GPU-A calls succeeded; compute 25 and router 158 tests initially passed before further truth audit.
- Removed fabricated compute API fallback replies, metrics, bookings and revenue history. Upstream failure returns an explicit unavailable error.
- All new route contracts published before 05:15 under `contracts/compute`: catalog, models, AWS SSE/poll, tasks estimate/quote, bookings/calendar. Routes mounted with one line each in index.ts. API catalog/models/quote smoke passed; quotes max 2ms in ten HTTP calls. Unmeasured model token rates remain null.
- Next rewrites prioritize `NEXT_PUBLIC_API_URL`. Vercel project resumed through its dashboard, verified HTTP 200; no redeploy. Morning tunnel commands and polling/cookie requirements are in docs/VERCEL.md. All prepared Akash manifests name actual Qwen2.5 weights; no lease changed.

## Next

- Finish truth audit: live official AWS prices, one physical GPU, metered revenue only.
- Restart stack using npm run demo with live compute/router and Bedrock disabled here. Verify routes, direct task and refund behavior.
- Run focused payment failure/idempotency integration and full service suites.
- Commit and push small changes, sync Alex at checkpoints, finish by backend freeze.

## Blockers

- Bedrock calls cannot be verified here without Alexander's AWS credentials. Estimation must use an explicit deterministic fallback here.
- All 6910 full transcript records were processed locally and the 46 user requests plus final implementation summaries reviewed. Earlier fake-data claims and old branch rules were superseded by this night run.
- Cloudflare Quick Tunnels explicitly do not support SSE. Vercel clients need 2 to 5 second polling over that morning tunnel.

## Requests

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

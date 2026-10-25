# Tharun night run

Updated 2026-10-25 04:48 ET. Branch `tharun`.

## Done

- Fetched, fast-forwarded `tharun` to `origin/alex` 6d7c8e4, and pushed.
- P0 repairs in progress: old vLLM request compatibility, continuation through text completions, failed-task full refund, and no successful fake fallback.
- Removed fabricated compute API fallback replies, metrics, bookings and revenue history. Upstream failure returns an explicit unavailable error.
- New route contracts are being published first under `contracts/compute` and `contracts/pricing`.
- Next rewrites now prioritize `NEXT_PUBLIC_API_URL`, matching the client API base.

## Next

- Finish and test GPU-A fresh and resumed execution and failed-task refund.
- Mount catalog, models and tasks routes with one line per router in index.ts.
- Validate live catalog, cached quotes, deterministic task estimator and paid future bookings.
- Resume Vercel existing production traffic, without deploying; write morning tunnel handoff.
- Correct prepared Akash model identities and rewrite AWS documentation around Bedrock and live prices.
- Commit and push small changes, sync Alex at checkpoints, finish by backend freeze.

## Blockers

- Bedrock calls cannot be verified here without Alexander's AWS credentials. Estimation must use an explicit deterministic fallback here.
- Prior transcript filenames from the user are not yet located. Repository and current source review continues independently.
- Cloudflare Quick Tunnels explicitly do not support SSE. Vercel clients need 2 to 5 second polling over that morning tunnel.

## Requests

- Kristian: `apps/api/src/gpuHealth.ts` still treats GPU-B as healthy without a live endpoint via `MOCK_GPUS`. Remove that exception so only health-checked real endpoints are listed. New catalog/models enforce real health independently.
- Kristian: `scripts/demo.mjs` still registers a fabricated GPU-B. Remove it from production startup; compute/router must not execute fake work.
- Kristian: add `aws` to shared `SseEventType`; Tharun will broadcast real refreshed values from an owned feed module.
- Alex: `apps/web/src/lib/api.ts` already prioritizes `NEXT_PUBLIC_API_URL`. Keep that shared base for every API request, SSE and router client. Correct visible model identity to Qwen2.5-1.5B-Instruct; the existing live endpoint still uses Qwen/Qwen3-1.7B as its wire alias.
- Alex and Lucy: Cloudflare Quick Tunnels do not support SSE. Poll every 2 to 5 seconds as a fallback. Same-origin `/api` is needed for existing SameSite=Lax session cookies; browser calls directly to a different tunnel origin will lose wallet sessions. Morning docs describe configuration.
- Alex: only your agent releases main and demo-safe. Tharun pushes only `tharun`.

## Decisions

- New night-run instructions supersede CLAUDE.md's older alex-only branch rule. Changes and pushes are restricted to `tharun`.
- Missing price, history or location is null/empty with source status; no invented values or backfilled 24-hour series.
- Actual GPU-A weights are Qwen2.5-1.5B-Instruct on Akash T4. The legacy served alias is transport metadata, not a product model claim.
- No Akash lease changes, no AKT spending, no new paid AWS resources and no Vercel deployment tonight.

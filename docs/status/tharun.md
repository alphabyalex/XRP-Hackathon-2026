DONE

# Tharun night run

Updated 2026-10-25 05:25 ET. Branch `tharun`. Completed before the backend freeze.

## Done

- Reviewed the prior session: 6910 full transcript records processed, all 46 user requests and final implementation summaries reviewed. The current night prompt supersedes older branch and fake-data notes.
- GPU-A fresh and resumed requests work on the existing Akash T4. Fresh chat uses standard vLLM 0.6.2 fields; partial replies continue through text completions with the chat template. Failed tasks refund the full cap. Truncated streams fail, never become canned success.
- Public model identity is Qwen2.5-1.5B-Instruct. The historical Qwen/Qwen3-1.7B alias is private transport metadata. Only the deployed model accepts requests; fitting undeployed models are on_request.
- All requested route contracts were pushed before 05:15: catalog, models, task estimate/quote, bookings/calendar and AWS SSE/poll. One line per router mounts the new files in index.ts.
- Catalog lists only verified GPU-A. Read-only existing lease SDL confirms 4 vCPU,16GiB RAM,100GiB storage. Provider record advertises LIS/PT/eu-southwest; the catalog displays Lisbon and Portugal. No lease was changed.
- Live aws SSE publication verified at 2026-10-25T09:24:29Z, carrying two spot and two on-demand prices. /catalog/aws exposes the matching polling snapshot.
- Catalog and router use the same cached live GPU Economy median. Verified one-hour quotes: all modes 0.550000/hour and 0.550000 total, with no invented speed difference. HTTP slider quote completed in 1ms. AWS spot/on-demand are timestamped comparisons from official public feeds, not hosted capacity.
- Calendar returns 168 real hourly blocks over seven days, with actual bookings/running work. Physical free/busy/reserved counts never multiply concurrency into GPUs; offline is not mislabeled reserved. Utilization appends observations only, with t/pct aliases for Alex's chart.
- Reservations require the signed account, honor live price caps, reject overlap and settle validated prepaid treasury payments. Stable Idempotency-Key prevents duplicate charges. Unknown outcomes retain durable pending state and the hold for reconciliation.
- gpuId (gpu_id alias) pins chat to GPU-A. Unknown/offline pins reject; replan cannot silently choose another GPU. Unbooked /inference/chat now uses real router payment/cap/refund settlement. Booked inference is free of additional token charge; missing, expired or wrong-owner booking IDs reject before execution.
- Live DEV verification: ord_43a4788e returned Moonshift from GPU-A and settled on XRPL. Estimate 0.000046, cap 0.000058, charged 0.000007, refunded 0.000051. Receipt hashes are in contracts/router/live_gpu_a_settlement.json. No Alexander account transaction was made.
- Removed fabricated adapter replies, metrics, bookings and revenue history. Real compute pricing meters live hourly rates against actual elapsed request time; unavailable rates fail closed. Revenue uses persisted actual usage charges, not fixed per-minute multipliers. Duplicate physical endpoints stay offline.
- Disabled the unverified Monte Carlo CPU toy in live mode. It constructs no engine, exposes no GPU/VRAM/latency metrics, returns empty status and rejects switch requests with FEATURE_UNAVAILABLE. Actual inference remains functional.
- Bedrock is opt-in with BEDROCK_ENABLED=1. Every Bedrock path uses deterministic fallback here, even with unrelated local AWS credentials. Live estimator smoke returned fallback in 2ms and prices from real cached rates.
- Vercel project moonshift resumed in its dashboard, production HTTP 200 verified. No redeployment performed. docs/VERCEL.md gives exact morning Cloudflare and Vercel environment commands, same-origin session requirements and polling fallback. docs/AWS.md describes Bedrock guards and real feeds. All prepared SDL model names now match their weights.
- Stack is running locally via npm run demo, with real compute/router, public prices, Bedrock disabled and IPv4 loopback workarounds for AirPlay. Main web is localhost:3000, API localhost:4000.
- Final validation: compute 40 passed; router 168 passed; pricing 26 passed; focused API 47 passed; XRPL 10 passed. All four workspace typechecks pass. Fresh isolated production build at 523fa8a passed lint/type checks and generated all 24 pages, including Docs and Models. Live .next was never overwritten.
- Merged Alex's current integration, including Lucy's Docs/Models/Lend work. Only tharun was pushed. Alex already integrated the functional backend ahead of schedule; final main/tag release remains his lane.

## Next

- No unfinished Tharun implementation. Alex integrates the final status/receipt updates and performs release validation, main fast-forward and demo-safe tagging.
- Apply the named owner requests below before final release. No further Tharun source push is planned.

## Blockers

- Latest full API run: 58/59 passed. The one old liveIntegration assertion assumes two READY GPUs; GPU-B is correctly OFFLINE. This requires Kristian's owned test/health cleanup, not restoring fake capacity.
- Real Haiku must be verified once on Alex's machine with BEDROCK_ENABLED=1 and his accessible model profile. Fallback is expected and tested here.
- Interrupted reservation/payment confirmations need operator reconciliation. The API never blindly resubmits or falsely confirms them. This limitation is documented in contracts/compute/bookings.json.
- Cloudflare Quick Tunnels do not support SSE. The morning tunnel setup must use 2 to 5 second polling. The current Vercel deployment remains the older build until Alex's morning release.

## Requests

- Alex: preserve /api on the browser origin and NEXT_PUBLIC_API_URL for server/upstream requests in your shared api.ts client. Direct tunnel-origin browser calls lose the current SameSite=Lax wallet session. next.config.mjs already routes /api to the public upstream. Follow docs/VERCEL.md.
- Alex: hide InstantSwitchCard and any fallback Monte Carlo GPU/VRAM/preemption statistics. The old UI hardcodes 3.12ms. The backend now truthfully disables this unverified feature; planned GPU risk work belongs on Docs only.
- Alex: your price-alignment and GPU-A pin requests are complete and live-verified. Unsupported non-inference execution returns TASK_TYPE_UNAVAILABLE. Consume booking redemptionId as the inference bookingId; scheduler bookingId is a different record identifier.
- Kristian: remove the MOCK_GPUS exception in gpuHealth.ts and the phantom GPU-B startup in scripts/demo.mjs. New catalog/router enforce one physical GPU independently. Update the obsolete two-READY-GPU integration assertion.
- Kristian: scripts/demo.mjs must use 127.0.0.1 for every spawned local service URL, including risk URL given to credit. AirPlay can share wildcard port5000 while localhost selects IPv6 and returns403. Owned compute/router normalize IPv4; NODE_OPTIONS=--dns-result-order=ipv4first is the current workaround for other adapters.
- Kristian: make helpers.recordUsage revenue ingestion idempotent. INSERT OR REPLACE still calls addRevenue again on retries. Tharun removed duplicate API-side recording for booked inference and routed public unbooked inference through validated settlement.
- Kristian: add aws to shared SseEventType. Runtime AWS broadcasting and /catalog/aws already work. Your old /pricing/resources route still returns static RESOURCE_BREAKDOWN; use the truthful pricing-service /pricing/resources response, whose unpublished component prices are null.
- Alex and Kristian: do not infer cash income from older fixed-rate revenue history. Unmetered monetary data stays empty. Historical receipt preservation remains intact.
- Alex and Lucy: keep polling fallback for the morning Quick Tunnel. Main and demo-safe are Alex's release responsibility; Tharun has not pushed either.

## Decisions

- Current night instructions override CLAUDE.md's older alex-only branch rule. All edits stayed within Tharun ownership, apart from pulling teammates' committed work.
- Only one healthy deployed physical T4 is executable. Prepared manifests are not live capacity. No invented prices, utilization history, token counts or alternative-model success.
- CPU/RAM/storage are included in the whole-node live median within verified limits. Separate unpublished component tariffs stay unavailable. Unknown token totals remain null, not invented zero.
- No Akash deployment/lease mutation, no AKT spending, no new paid AWS resource and no Vercel deployment. Bedrock stays disabled on this machine. Validation ledger writes used DEV only.

RELEASE IN PROGRESS

# Tharun morning integration

Updated 2026-10-25 10:20 ET. Branch `tharun`. The user's morning instruction authorizes integration into main, multiple Akash GPU leases and cloud deployment, superseding the night freeze.

## Done

- Reviewed the prior session in depth: 6910 transcript records, all 46 user requests and implementation summaries. Older archived prompts were not read.
- Fetched and merged main, Alex, Kristian and Lucy. Latest fetched main/Alex is 16c697a. Current application includes all four teammates' morning changes.
- Preserved the existing local `contracts/collateral.devnet.json` records without staging or resetting them. They are included in the private state migration.
- Used actual akt 1.0.4 for provider screening, bids, deployment, lease acceptance, hardware inspection and model verification. GPU-A remains its original T4 16 GiB lease. GPU-B is a separate V100 32 GiB lease at ZenCloud, with 4 vCPU, 16 GiB RAM and 50 GiB storage.
- Actual weights: GPU-A Qwen2.5-1.5B-Instruct, GPU-B Qwen2.5-3B-Instruct, both context 4096. GPU-A's old transport alias remains internal. Each serving model is pinned to its actual GPU; duplicate URLs cannot count twice.
- Fixed direct/chat stream serialization, cancellation cleanup, transient retries before output and reclaimed-stream cleanup. Inference failures retain full-cap refunds.
- Unified API and router pricing around each verified lease cost plus margin. Actual accepted lease bids: A 272 uact/block, B 383.910083 uact/block. At 600 blocks/hour with 25% margin, rental rates are 0.204000/hour and 0.287933/hour. GPU Economy remains a comparison. Only fresh same-card AWS ratios affect priority discounts.
- Measured GPU-B's 3B endpoint with two 128-token completions. Conservative planning estimate 61.756527 output tokens/second includes network and prefill time; source observations are committed. This fixes zero-throughput V100 planning.
- Replaced stale V100/T4 identity and fabricated component prices across catalog, legacy GPU reads, portfolio, returns and the rental UI. Bundled RAM/storage say Included in node rate.
- Real paid DEV tasks on both GPUs returned 46 and settled validated payments. Cap equals charge plus refund exactly. Receipts are in `contracts/compute/live_fleet_settlement.json`. No Alexander account was used.
- Backend deployed to Akash Palmito, dseq 1792936961914: 2 vCPU, 4 GiB RAM, 20 GiB persistent storage. Only API 4000 is public; five Python services use loopback. Official Node image and release f9d3e85 are pinned.
- Drained orders and stopped all 12 local stack processes before migration. All 11 copied file hashes, all database table counts and SQLite integrity checks matched. Existing wallet accounts, sessions, reservations and collateral records are preserved.
- Backend activation succeeded. HTTPS health, both catalog GPUs and both canonical serving models return 200 at `https://hqlndvicrddu7bkcop8kaptoh8.ingress.akash-palmito.org`.
- Backend uses separate strong operator credentials supplied through native Console secret references. The account encryption key is preserved. No Akash management keys or AWS credentials are transferred to the runtime.
- Validation: compute 48, router 172, pricing 26, API 64 and all 10 XRPL groups pass. All workspace typechecks pass. Six backend safety tests cover process cleanup, writer fencing, WAL-safe snapshots, integrity gates and persistent state. Fresh isolated frontend production build passed all 24 pages at a9e5e6b; runtime secrets and live .next were untouched.

**Decisions:** Added one economical real GPU rather than creating speculative capacity. Existing GPU-A is untouched. Bid caps were 500 uact/block for GPU-B and 50 for the backend. Actual combined Akash estimate is about $9.68/day at 600 blocks/hour, with ongoing auto-funding. Paid AWS and Bedrock calls remain disabled; task sizing reports deterministic fallback.

## Next

- Publish the completed integration to main after the final cloud settlement receipts.
- Deploy the verified frontend to Vercel with the Akash API origin and verify desktop/mobile pages, cookies and same-origin API reads.
- Record the completed release and final commit/deployment identifiers.

## Blockers

- No core backend blocker. Paid Bedrock is intentionally disabled on this backend; fallback remains explicit and tested.
- akt 1.0.4 shell does not forward stdin EOF. The migration used bounded input, then verified every hash before activation. The backend update CLI returned nonzero after successfully applying the requested revision; actual saved SDL and running revision were verified, and no duplicate update was attempted.
- Interrupted payment outcomes still require ledger reconciliation before any retry, as documented in the booking contract.

## Requests

- Teammates: pull the published main before further work. Do not start a second backend writer using the same accounts or restore an old laptop state over the cloud state.

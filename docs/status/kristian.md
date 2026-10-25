# Kristian night run (2026-10-25)

## Done
- Read all six pages of the supplied night-run specification. Synced origin/alex (5526a8c) into kristian and pushed only kristian.
- Scope: API, XRPL/shared packages, risk, scripts and owned contracts. No edits to UI, Tharun-owned API marketData/proxy files or infrastructure.
- Investigating P0 price feedback and reset idempotency first. Contract shapes are being published before implementation for the UI lanes.

## Next
- P0: stable market-maker opening anchors, unified stats, strict borrow limits, collateral options, truthful labels/health.
- P1: validated ledger order books/fills/candles, lending markets/dashboard/loan book/applications, allowlisted activity process.
- Validate on the local stack with real ledger reads/transactions where configured. List environmental failures honestly.

## Blockers
- BRAND.md is absent from this checkout. Backend work follows the explicit product/data rules in the supplied specification.

## Requests
- Alex: wire Home, Market, GPU and Portfolio to GET /gpus/:id/stats. Keep price distinct from navPerShare. GPU calendar route and market contract shapes follow in contracts/api and contracts/market. UI remains yours.
- Lucy: wire collateral options and strict OVER_LIMIT responses; use upcoming /lending/* and /applications contracts. No silent principal reduction is permitted.
- Tharun: remove generated/fallback compute revenue and metrics in your lane; expose only endpoint-verified GPUs. GPU-A is the real Akash T4/Qwen2.5-1.5B-Instruct; no AWS EC2 label. Keep GPU Economy polling at its source-permitted cadence while client SSE/polls run every 2-5 seconds.

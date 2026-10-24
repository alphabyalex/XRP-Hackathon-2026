# Lucy status (services/credit, Quicknode)

## Done
- Phase 0: verified Quicknode XRPL support from their docs, wrote docs/QUICKNODE.md.

## Next
- Phase 1: contracts/credit/*.json and the services/credit FastAPI skeleton.

## Blockers
- No `.env` in the repo yet, so `QUICKNODE_XRPL_MAINNET_URL` and
  `QUICKNODE_XRPL_TESTNET_URL` are unset. The service falls back to public
  XRPL endpoints and labels every response `source: "public"` until a human
  adds them.

## Decisions
- Live monitoring will use a Quicknode WebSocket `subscribe` (accounts stream),
  not Quicknode Streams or Webhooks: Streams on XRPL only offer the whole-ledger
  dataset, Webhooks need a public receiver URL, and the docs disagree on whether
  either is on the free plan.
- Followed the Lucy prompt's branch rule (commit and push to `lucy`) over the
  root CLAUDE.md, which is written for Alexander's own session (`alex` branch).

# Kristian Risk Desk status

## Done

- Phase 1: added the Risk Desk service skeleton, health route, port 7000
  README, and contract examples for quote, loan health, scenarios, book stats,
  and SSE events.
- Added the proposed keeper API routes to the bottom of `docs/CONTRACTS.md`.
- Phase 1 checks: 2 service tests pass, all five contract examples parse as
  JSON, and `git diff --check` is clean.

## Next

- Phase 2: implement deterministic quote calculations with Decimal money.
- Phase 3: add the dry-run keeper and event stream.
- Phase 4: add gated simulated stress scenarios.
- Phase 5: add the seeded 30-day loan-book simulator.
- Phase 6 and stretch: complete docs, rate curve, and vault health summary.

## Blockers

- The API does not yet expose the internal loan and oracle-history routes
  requested in `docs/CONTRACTS.md`. The keeper will use a deterministic mock
  provider until those routes are available.
- No live first-loss-cover or vault-deposit feed is currently defined. Vault
  health will report configured demo assumptions as simulated.

## Decisions

- Follow the prompt's team map and keep risk implementation inside
  `services/risk/`; add only the requested contracts, status note, and API
  contract requests outside that folder.
- Keep `MOCK=1` and `KEEPER_DRY_RUN=1` as the defaults. The service will not
  submit ledger transactions.


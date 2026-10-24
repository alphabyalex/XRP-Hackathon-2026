# Kristian Risk Desk status

## Done

- Phase 1: added the Risk Desk service skeleton, health route, port 7000
  README, and contract examples for quote, loan health, scenarios, book stats,
  and SSE events.
- Added the proposed keeper API routes to the bottom of `docs/CONTRACTS.md`.
- Phase 1 checks: 2 service tests pass, all five contract examples parse as
  JSON, and `git diff --check` is clean.
- Phase 2: implemented Decimal-based loan quotes, credit-grade pricing,
  confidence and volatility adjustments, dividend coverage, estimated PD, and
  expected loss. The quote example returns its documented response exactly.
- Phase 2 checks: 7 service tests pass and Python compile checks pass.
- Phase 3: added the interval keeper, persisted cure windows, idempotent
  margin-call and liquidation actions, dry-run behavior, the mock loan/oracle
  source, loan-health endpoint, and bounded persisted SSE event log.
- Phase 3 checks: 14 service tests pass and Python compile checks pass.
- Phase 4: added gated stress scenarios for price, utilization, and default
  shocks. The mock stress applies a temporary keeper price override, records
  margin-call and liquidation events, and never calls the API action routes.
- Phase 4 checks: 16 service tests pass; the scenario response matches its
  contract example exactly.
- Phase 5: added a fixed-seed, 30-day loan-book simulator with grade-specific
  PDs and repaid, late, cured-margin-call, and liquidation outcomes. It supports
  a grade filter and labels every summary as simulated.
- Phase 5 checks: 19 service tests pass and the grade-C response matches its
  contract example exactly.

## Next

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


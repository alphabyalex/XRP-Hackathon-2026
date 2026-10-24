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
- Phase 6 and stretch: documented pricing, PD, loss, stress, simulation, and
  portfolio formulas; added the grade APR curve and simulated vault health
  endpoint with contract examples.
- Final checks: 22 service tests pass, Python compile checks pass, all seven
  risk contract examples parse as JSON, and `git diff --check` is clean.

## Round 2, job 1: Devnet funding (2026-10-24)

- Fetched and fast-forward merged `origin/alex` at `cca9d0d` on `kristian`.
- Added public-address-only `tools/devnet-faucet/fund.py`, documentation, and
  three passing tests. Verified destination requests against XRPL docs and
  response handling against official xrpl.js. No wallet created or secrets read.
- Live run succeeded. Every account below 100 XRP received 300 XRP and was
  verified on the validated Devnet ledger. The target is a minimum of 300 XRP.

| name | address | XRP before | XRP after |
| --- | --- | ---: | ---: |
| TDX_ISSUER | r3jvZbjo4PKok6Yz3Xfv2yx8aKkjfSXjz5 | 99.99998 | 399.99998 |
| SHARE_ISSUER | rB29QejupDfDp3ZobaM26Frs6Q3RWBQswS | 99.999993 | 399.999993 |
| CONTRACT_ISSUER | rDam1umNmt7quBJoYfGbM9nNzeHKvh8eiP | 99.999996 | 399.999996 |
| TREASURY_GPU_A | rwF4334JcDQKcAS7H25Z1G5EnndjWFyykH | 99.999989 | 399.999989 |
| TREASURY_GPU_B | rEnnzc2Ev8Yq3v8Qkjj5G3PhGjUbAPDsvR | 99.999993 | 399.999993 |
| PROTOCOL_FEES | rGM67q5oNc74RpNkTU47nDEcyZ1tSBS24m | 99.999999 | 399.999999 |
| LENDING_POOL | rsWQVjDESTe9JsS3DXL92icYXtpBF4Xktw | 99.588114 | 399.588114 |
| ORACLE | r3rRTiphx6wQpqVjRpA4BVh6mjsPbsU9zr | 99.999968 | 399.999968 |
| ALICE | rPScK1uuXC9szrSg2qqkzMYqXGvK6Q2hYT | 99.999958 | 399.999958 |
| BOB | rUYwgUBQi7eTFDjbJMEjpNbyzXvFTUUsx1 | 99.999979 | 399.999979 |
| CAROL | rhkYPaGdTMRvMs85KhvVaUYMoBDnvgpiJr | 99.999993 | 399.999993 |
| DEV | rDBNrgqBmMV3ebnFWhnyxZkdUQb7GZkejc | 99.999992 | 399.999992 |

## Next

- Round 2 jobs are authorized for a commit and push after each job.

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


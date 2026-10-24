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

## Round 2, job 2: real-round risk terms

- Job 1 committed and pushed as `4ce3c1b`.
- Read the merged API lending flow and CONTRACTS. Coverage now includes 80%
  of gross revenue over the complete collateral holding period plus 35% of
  spot collateral value. Capacity is independent of requested principal and
  remains bounded by the existing grade, confidence, and volatility limits.
- README formulas explain the 65% underwriting haircut and distinguish it
  from the LGD execution haircut. The API fallback port matches these formulas.
- Schedule now returns `max(60, configured interval, ceil(term / 30))`.
  Default term is 14 days; the API still caps it to the actual round end.
- Updated `contracts/risk/quote.json` to a realistic GPU-A B request. Both
  examples below use 100 shares at 5.25 USDC, daily gross revenue 48.2 USDC,
  confidence 0.9, stable prices, and a 1,209,600 second term (14 days).

| quote | B, score 82 | E, score 25 |
| --- | ---: | ---: |
| Principal USDC | 105.000000 | 210.000000 |
| Decision | approve | decline |
| LTV | 0.200000 | 0.400000 |
| Max LTV | 0.451255 | 0.195000 |
| APR | 0.090800 | 0.345000 |
| Margin call LTV | 0.601255 | 0.345000 |
| Liquidation LTV | 0.751255 | 0.495000 |
| Payment interval seconds | 40320 | 40320 |
| PD estimate | 0.053000 | 0.521000 |
| Expected loss USDC | 0.000000 | 0.000000 |
| Coverage ratio | 2.256275 | 1.117282 |
| Reasons | none | LTV_ABOVE_MAX, HIGHEST_RISK_GRADE |

- Checks: all 27 risk tests pass, including B at 20%, E at 40%, a 30% shock
  taking a 45% loan to 64.29% LTV, principal-independent limits, and interval
  rounding. Python compile check passes. API typecheck could not run because
  this environment has no Node/npm or installed workspace dependencies.

## Round 2, job 3: round yield and demo preset

- Job 2 committed and pushed as `3c33148`.
- Added authenticated `GET /vault/round-apy` with input validation, current
  annualized yield, explicit 80% target utilization, target estimate label,
  and projected expected loss from the open loan book. Loss is scaled to target
  exposure and annualized over the round duration. README documents the whole
  book proxy, empty book behavior, and simple annualization convention.
- Added `contracts/risk/round_apy.json` and Alex's `/lend` display request at
  the bottom of CONTRACTS. UI wiring is assigned to Alex by this request.
- Example: `round=1&assets=10000&lentOut=150&weightedApr=0.086667` returns:

```json
{
  "round": 1,
  "realizedApy": "0.001300",
  "targetApy": "0.069334",
  "targetApyLabel": "estimate",
  "targetUtilization": "0.800000",
  "expectedLoss": "0.000000",
  "bookExpectedLoss": "0.000000",
  "lossRate": "0.000000",
  "lossBasis": "all-open-loans",
  "roundSeconds": 1209600,
  "simulated": true
}
```

- Stretch: `/scenarios?preset=demo` exposes two single-call steps, each sent to
  `/scenarios/run`. GPU-A prices are computed from live loan thresholds; step 1
  crosses margin call, step 2 crosses the existing emergency liquidation rule.
  GPU-B is untouched and all actions remain simulated under the existing gate.
- Checks: 39 risk tests pass, including loss scaling/annualization, negative
  target yield, empty book, invalid inputs, auth, and both demo steps. Funding
  tool's 3 tests also pass. Python compile, contract JSON, and diff checks pass.

## Next

- Round 2 implementation complete. Alex can wire the documented APY estimate
  into `/lend` and merge `kristian`.

## Blockers

- The merged API now provides the internal loan and oracle-history routes.
  Enable live keeper reads through process environment settings when deployed.
- No live first-loss-cover or vault-deposit feed is currently defined. Vault
  health will report configured demo assumptions as simulated.

## Decisions

- Follow the prompt's team map and keep risk implementation inside
  `services/risk/`; add only the requested contracts, status note, and API
  contract requests outside that folder.
- Keep `MOCK=1` and `KEEPER_DRY_RUN=1` as the defaults. The service will not
  submit ledger transactions.


# Status: Alex lane (packages/xrpl, packages/shared, apps/api, apps/web, docs)

Updated after each phase. Newest phase first in Done.

## Done

### Phase 1: devnet lending spike (2026-10-24 12:50 EDT)
- Full XLS-65/66 cycle works on devnet. TDX IOU vault, Moonshift broker with first-loss cover, GPU shares escrowed as collateral, LoanSet with borrower countersign, LoanPay, full payoff, atomic Batch collateral release, LoanDelete. A second loan was impaired, defaulted and its collateral seized. Hashes in docs/SPIKE_DEVNET_LENDING.md.
- Upgraded xrpl.js 4.7.0 to 5.3.0 (packages/xrpl, apps/api). 4.7.0 countersignatures are rejected by rippled 3.4.1.
- New script: `npm run spike:lending -w packages/xrpl`.

### Phase 0: sync (2026-10-24 12:20 EDT)
- Fetched all branches. `main` and `kristian` were already at `fa875da` (same as `alex`). `lucy` had nothing new.
- Merged `origin/tharun` (permissioned shares, payment channels, xrpl unit tests). Typecheck passes for web, api, shared, xrpl. `npm run test:xrpl` passes all 8 tests.
- Renamed Tharun's new `GB_KYC` credential type to `MS_KYC`, so no `GB_` names remain.
- Checked the two seed-shaped strings in `packages/xrpl/test/xrpl.test.ts`. They are format fixtures for `getSigningAlgorithm`. One derives to an unrelated address and the other is not a valid seed. Neither controls a team account.

## Next
- Apply director_fixes_1.patch, then Phase 2: NETWORK switch and devnet setupNetwork with lending rounds.

## Blockers
- Python 3.11 or newer is not installed on the integration machine (only 3.10). The pricing and compute services both fail to import (`datetime.UTC`). That blocks running pricing, compute, risk and credit locally. Fix: install Python 3.12 (`winget install Python.Python.3.12`), which needs Alexander's OK because it's a system install. Until then, the api talks to those services through their MOCK modes and contract JSON.

## Decisions
- Lending runs in rounds. LendingProtocolV1_1 requires a closed-ended vault for new loan brokers, so one vault cannot take deposits and make loans at the same time. Demo world: one round investing (borrowers draw) plus one round subscribing (lenders deposit).
- Prompt collateral release: escrow shares to the broker with a condition; on repay, the broker submits Batch(EscrowFinish + return shares) atomically. CancelAfter is the borrower's safety valve.
- Loan payments round up to 6 decimals (ledger numbers exceed IOU precision).
- The `MS_KYC` credential type renames Tharun's `GB_KYC`. Nothing on-ledger depends on the old value yet.

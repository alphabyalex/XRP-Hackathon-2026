# Status: Alex lane (packages/xrpl, packages/shared, apps/api, apps/web, docs)

Updated after each phase. Newest phase first in Done.

## Done

### Phase 0: sync (2026-10-24 12:20 EDT)
- Fetched all branches. `main` and `kristian` were already at `fa875da` (same as `alex`). `lucy` had nothing new.
- Merged `origin/tharun` (permissioned shares, payment channels, xrpl unit tests). Typecheck passes for web, api, shared, xrpl. `npm run test:xrpl` passes all 8 tests.
- Renamed Tharun's new `GB_KYC` credential type to `MS_KYC`, so no `GB_` names remain.
- Checked the two seed-shaped strings in `packages/xrpl/test/xrpl.test.ts`. They are format fixtures for `getSigningAlgorithm`. One derives to an unrelated address and the other is not a valid seed. Neither controls a team account.

## Next
- Phase 1: devnet lending spike (XLS-65 vault, XLS-66 loan broker and loan).

## Blockers
- Python 3.11 or newer is not installed on the integration machine (only 3.10). The pricing and compute services both fail to import (`datetime.UTC`). That blocks running pricing, compute, risk and credit locally. Fix: install Python 3.12 (`winget install Python.Python.3.12`), which needs Alexander's OK because it's a system install. Until then, the api talks to those services through their MOCK modes and contract JSON.

## Decisions
- The `MS_KYC` credential type renames Tharun's `GB_KYC`. Nothing on-ledger depends on the old value yet.

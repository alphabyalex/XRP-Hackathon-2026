# Status: Alex lane (packages/xrpl, packages/shared, apps/api, apps/web, docs)

Updated after each phase. Newest phase first in Done.

## Done

### Demo ready (2026-10-24 14:15 EDT)
- `npm run demo:reset` then `npm run demo`, open http://localhost:3000/borrow and /lend. `npm run demo:check` runs the whole path and prints the tx table (docs/DEMO.md).
- Two clean full runs on devnet from a fresh reset after the keeper race fix (see docs/DEMO.md for hashes).

### Phase 7: cleanup
- docs/RUNBOOK.md rewritten: all processes, shared INTERNAL_API_KEY, per-service venvs, demo commands, fallbacks.
- Revenue split is now exactly 80/15/5 of gross (reserve from gross) in packages/shared, the web split and the api mock. Requests to Tharun (pricing) and Kristian (risk projected_dividends) are in CONTRACTS.md.
- Stale xrplAdapter.ts comment fixed.

### Phase 6: web
- /borrow: credit profile with top factors and tx links, live risk quote, memo, open on devnet, live loan health with margin call and liquidation lines, pay installment, pay off with collateral release, stress controls.
- /lend: rounds (lending now, open for deposits), deposit and withdraw, lender position, loan book, simulated grade stats, stress test results. Nav gains Lend.
- Removed placeholders: the 1,284.20 balance and the L4 row (director patch 1).

### Phase 5: off mocks
- api on devnet with MOCK_XRPL=0 runs every lending step with real transactions. Python services are not running here (no Python 3.11+), so pricing, risk and credit use the built-in mocks, labeled simulated.

### Phase 4: api wiring
- Adapters for credit, risk, pricing memo and alerts, compute revenue, lending (devnet or in-memory). Built-in mocks fall back when a service is down.
- Public lending routes, internal keeper and credit routes (idempotent), SSE loan/vault/credit/risk events, background defaulter and built-in keeper. Answers to every teammate request are at the bottom of docs/CONTRACTS.md.

### Phase 3: lending library (2026-10-24 13:30 EDT)
- XLS-66 loans with GPU-share collateral in packages/xrpl: openLendingLoan, repayLendingLoan (installment or payoff), prepayLoan (margin call cure), marginCall, impairLoan/unimpairLoan, liquidateLoan, defaultLoan, getLedgerLoan, listLedgerLoans (read from the broker pseudo-account on ledger), getVaultSummary (lender APY from open loans).
- Collateral bug fixed: repaid loans release shares immediately in one atomic Batch (EscrowFinish + return). Also applied to the testnet escrow loans.
- Escrow keys are derived (HMAC of broker key + public nonce), so nothing secret is stored. The loan to escrow link is in contracts/collateral.devnet.json and can be rebuilt from the LoanSet tx on ledger (tested).
- Compatibility: openLoan/repayLoan/settleLoan keep their names and shapes; on devnet they use XLS-66.
- `NETWORK=devnet npm run xrpl:smoke` runs the old smoke plus the full lending cycle; all green.

### Phase 2: network switch and devnet world (2026-10-24 13:05 EDT)
- `NETWORK=devnet|testnet` (packages/shared/src/network.ts) picks node, faucet and explorer. Devnet never uses Quicknode; DEVNET_WSS is the only devnet override. Endpoints are redacted before printing (Quicknode URLs carry a token).
- Devnet accounts are separate: seeds `DEVNET_<NAME>_SEED` (written to .env by setup, never printed), addresses in `contracts/accounts.devnet.json`.
- `NETWORK=devnet npm run xrpl:setup` rebuilds everything and is safe to rerun: issuers and flags (incl. AllowTrustLineLocking for share escrow), TDX, GPA/GPB shares, HRA/HRB contract tokens, DEX offers, oracle per GPU, and two lending rounds (vault + broker + cover). Round IDs in `contracts/lending.devnet.json`.
- Round 1 (investing): 7000 TDX from BOB and CAROL, 1000 TDX cover, term to 2026-11-07. Round 2 (subscribing): 1000 TDX, deposits open until 2026-10-27.
- New lending library (packages/xrpl/src/lending.ts): createVault, depositToVault, withdrawFromVault, getVault, getVaultShares, setupLoanBroker, depositCover, getLoanBroker, createRound.
- Tests: 10/10 (new: network switch, redaction, lending math).

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
- Stretch: Quicknode for testnet reads (docs/QUICKNODE.md), one-click demo button on the landing page.
- When Python 3.12 is installed: run `npm run demo` again so pricing, risk and credit run live, then rerun `npm run demo:check`.

## Blockers
- Python 3.11 or newer is not installed on the integration machine (only 3.10). The pricing and compute services both fail to import (`datetime.UTC`). That blocks running pricing, compute, risk and credit locally. Fix: install Python 3.12 (`winget install Python.Python.3.12`), which needs Alexander's OK because it's a system install. Until then, the api talks to those services through their MOCK modes and contract JSON.

## Decisions
- Loan term is capped to the vault round's redemption date minus 3 h (LoanSet past it fails with tecNO_PERMISSION). Default requested term is 30 days, so round 1 loans quote about 13.8 days.
- Payment interval = max(risk interval, term / 30): at most 30 installments.
- The api keeper pauses while a stress run is in progress, and keeper actions take a per-loan lock, so two keepers never act on one loan at once (found in a run: double EscrowFinish gave tecNO_TARGET).
- Demo personas: ALICE borrows, BOB deposits.
- Margin call = MS_MARGIN_CALL memo + api state. The ledger refuses LoanManage impair before a payment is late, so impair is used only for late loans.
- Liquidation = seize the escrowed shares now, then LoanManage default once due date + grace passes (the broker cannot LoanPay for the borrower). First-loss cover absorbs part of the vault loss. The api runs a background defaulter for liquidated loans.
- Loans are opened with the overpayment flag so a borrower can cure a margin call by prepaying principal (installment + extra).
- The Moonshift broker is the existing LENDING_POOL account (owns every vault and loan broker). BOB and CAROL are the demo lenders.
- NETWORK defaults to testnet in code when unset (keeps old behavior); .env.example now says devnet. The demo start script sets NETWORK=devnet explicitly.
- Rerunning setup tops balances back up to their targets (TDX 10000 per persona). Harmless on devnet.
- Lending runs in rounds. LendingProtocolV1_1 requires a closed-ended vault for new loan brokers, so one vault cannot take deposits and make loans at the same time. Demo world: one round investing (borrowers draw) plus one round subscribing (lenders deposit).
- Prompt collateral release: escrow shares to the broker with a condition; on repay, the broker submits Batch(EscrowFinish + return shares) atomically. CancelAfter is the borrower's safety valve.
- Loan payments round up to 6 decimals (ledger numbers exceed IOU precision).
- The `MS_KYC` credential type renames Tharun's `GB_KYC`. Nothing on-ledger depends on the old value yet.

# Spike: XLS-65 vault and XLS-66 loans on devnet

Date: 2026-10-24. Script: `packages/xrpl/src/scripts/spikeLending.ts` (`npm run spike:lending -w packages/xrpl`). Raw run output with every ledger entry: `packages/xrpl/spike-devnet.json`.

**Result: a full cycle works on devnet.**
- A closed-ended vault holding our TDX IOU takes lender deposits.
- Moonshift is the loan broker, with first-loss cover.
- ALICE escrows GPU shares as collateral, borrows, makes a scheduled payment and pays off early. The collateral is released immediately in one atomic Batch, and the loan is deleted.
- A second loan goes late, is impaired, then defaulted. Its escrowed shares are seized, and first-loss cover absorbs part of the loss.

XLS-66 has no collateral concept of its own. The GPU share escrow is the collateral layer Moonshift adds on top, and that is our differentiator.

## Network facts (checked live, rippled 3.4.1)

| Amendment | devnet | testnet |
|---|---|---|
| LendingProtocol | enabled | not enabled |
| LendingProtocolV1_1 | enabled | not enabled |
| SingleAssetVault | enabled | not enabled |
| TokenEscrow | enabled | enabled |
| BatchV1_1 | enabled | enabled |
| PriceOracle | enabled | enabled |
| MPTokensV1 | enabled | enabled |

Lending therefore runs on devnet only: `wss://s.devnet.rippletest.net:51233`, explorer `https://devnet.xrpl.org`.

## xrpl.js version

- xrpl.js 4.7.0 has the types, but its LoanSet countersignature is rejected by rippled 3.4.1 with `fails local checks: Counterparty: Invalid signature`.
- **Upgraded to xrpl.js 5.3.0** in `packages/xrpl` and `apps/api`. With 5.3.0 the same LoanSet succeeds.
- The official xrpl.org samples pin 5.2.0.
- All four TS packages typecheck on 5.3.0 and the xrpl unit tests pass.

## The run (tx hashes, devnet)

| Step | Result | Tx |
|---|---|---|
| VaultCreate, TDX IOU, closed-ended | tesSUCCESS | `15E30264831F6C98132264CF34DEC97109419B00F07D61296AB7B232CD787CF9` |
| LENDER VaultDeposit 5000 TDX (subscription phase) | tesSUCCESS | `5E0C0CD137A4A9EDAAD05D9A435454A548B34AEAD4A61CEEE1B5902D46DE2748` |
| LENDER VaultWithdraw 50 TDX (subscription phase) | tesSUCCESS | `170454C9108F8CCD9B5660B7B04EFEFAD5958A189F9C0A2C593A29F048EEA169` |
| LoanBrokerSet | tesSUCCESS | `43641715C17B7A7604595F987E3056F89E07141D3EECD71E7859EE4E62F748BA` |
| LoanBrokerCoverDeposit 200 TDX | tesSUCCESS | `28A41881FC2F718C151EE3EA91D7BFCF5E08C7CE5D5D5F6F34F46C4D1BC9B9F7` |
| VaultDeposit during investment phase | tecEXPIRED (expected) | `D140638A574D78A33B2F4405DB51E97930F55F692FDA5B0DA1DF95C659F75AD6` |
| Loan A: ALICE escrows 100 GPU shares to broker | tesSUCCESS | `17230ABEBAA0C59ACE4F41FAB18BDC117A4F005FE3AF0E2B0EE90B9D050E402E` |
| Loan A: LoanSet (broker signs, ALICE countersigns) | tesSUCCESS | `C3F4C746677CA83F0AD796E420CCB89B8EC0F7E0FFFD673F186966070EE6C6B2` |
| Loan A: LoanPay periodic | tesSUCCESS | `C2145707E993E6E606C2439C08AF0D8C0286554E22914F0A69BE1698F4D53897` |
| Margin call memo (`MS_MARGIN_CALL`, 1 drop to borrower) | tesSUCCESS | `D8D9F3C17F0030D2128A594925544AC8AA8DAFF7DC1C3D290AF4930D2018D11A` |
| Loan A: LoanPay full payoff (`tfLoanFullPayment`) | tesSUCCESS | `65711D23039013F9EFFC4DC3F659F43869E74EC155A346EF10216AD61A1D99FC` |
| Loan A: Batch(EscrowFinish + return shares), all or nothing | tesSUCCESS | `B4CC545415B7F44FD1F0B2F5DEF7EA9612E6138713CA2120888149AADF3D4AE4` |
| Loan A: LoanDelete | tesSUCCESS | `16EE911C4163B1F9BC100CA1EEFDD5E673EE2DAC51EA29C24EF1282E2455B67A` |
| Loan B: escrow 50 shares | tesSUCCESS | `BB934CB2FF5F8C94C9F426EECE3240041DD47F6CFD5AD35B745EBA3CB17790D4` |
| Loan B: LoanSet (1 payment, 60 s interval, 60 s grace) | tesSUCCESS | `7F9537C296C8DD3D06BD531817D2B67302C366DDF32E74482073042DDCB42D74` |
| Loan B: LoanManage `tfLoanImpair` (after due date) | tesSUCCESS | `4434A56BDA448876055DB8B2E33D96D5F26EC95F07924630010317D59C16E989` |
| Loan B: LoanManage `tfLoanDefault` (after grace) | tesSUCCESS | `1049F59DF69F1DA9165035349406BC09E044003CF7E62297144803C64CB797E9` |
| Loan B: seize collateral (EscrowFinish to broker) | tesSUCCESS | `E43C99AF6C07682E105A251CA53482B7A7950A6C77E9A70E2AEC07D90AD44066` |
| VaultWithdraw during investment phase | tecTOO_SOON (expected) | `2AB207EA2ECB8ACBD67FCB3B16B4C4042479F5AA52301B86FFA5E6C8F19D6E74` |

Every hash opens at `https://devnet.xrpl.org/transactions/<hash>`.

Final state:
- **Vault:** `AssetsTotal` = `AssetsAvailable` = 4665.001130. That is 4950 deposited, minus the 285 uncovered loss on loan B, plus loan A interest.
- **Broker:** `CoverAvailable` = 185. Default draw = 300 × 10% (CoverRateMinimum) × 50% (CoverRateLiquidation) = 15.
- **Loan B:** after default it carries flags `0x30000` (impaired and defaulted).

## Answers

### Can a vault hold an IOU like TDX?

Yes. `Asset: { currency: "TDX", issuer }` works. Requirements:
- The issuer needs `asfDefaultRipple`, otherwise `terNO_RIPPLE`.
- Depositors need a TDX trust line.
- Vault `Scale` defaults to 6 for trust line tokens, which matches TDX's 6 decimals.

No MPT is needed.

### The big constraint: closed-ended vaults

Under LendingProtocolV1_1, a **new** LoanBroker must sit on a closed-ended vault (`VaultKind: 1`). With an open-ended vault, `LoanBrokerSet` returns `tecNO_PERMISSION`.

A closed-ended vault needs `SubscriptionDate` and `RedemptionDate`:
- At least 180 s apart.
- Both later than the current ledger close time.
- Both immutable.

It moves through three phases:

| Phase | Window | Deposits | Withdrawals | New loans |
|---|---|---|---|---|
| Subscription | until SubscriptionDate | yes | yes | no |
| Investment | SubscriptionDate to RedemptionDate | no (`tecEXPIRED`) | no (`tecTOO_SOON`) | yes |
| Redemption | after RedemptionDate | no | yes | no |

**Product impact: lending becomes "rounds".** A round collects deposits, then lends for a fixed term, then pays out. To show deposits and borrowing at the same time, run two rounds:
- One in its investment phase, which borrowers draw from.
- The next one in its subscription phase, which lenders deposit into.

Each round is its own vault with its own LoanBroker owned by the Moonshift broker account. The broker account must own the vault, because only the vault owner can run `LoanBrokerSet`.

### Units

All in 1/10th basis points:
- `InterestRate`: 12000 = 12% APR.
- `ManagementFeeRate`: max 10000 = 10%. 1000 = 1% of interest.
- `CoverRateMinimum` and `CoverRateLiquidation`: max 100000 = 100%. Both must be zero or both nonzero.

Times (`PaymentInterval`, `GracePeriod`, dates) are seconds and Ripple epoch.

### Interest and the payment schedule

- `LoanSet` fixes `PaymentTotal` equal installments every `PaymentInterval` seconds.
- The ledger computes `PeriodicPayment`, `TotalValueOutstanding` (principal plus all scheduled interest), `PrincipalOutstanding`, `ManagementFeeOutstanding` (the broker's cut) and `NextPaymentDueDate`.
- Loan A example: 500 TDX at 12% APR, 3 × 600 s. `PeriodicPayment` was 166.667427702. After one payment, `PaymentRemaining` was 2 and the next due date moved by one interval.
- `LoanPay` with `tfLoanFullPayment` paid off the rest early, and `LoanDelete` then succeeded.
- Overpaying beyond due cycles is ignored unless the loan was created with `tfLoanOverpayment`.
- Late payments must match an exact amount (periodic + late fee + late interest).

**Precision gotcha:** ledger numbers carry up to 18 significant digits, but IOU amounts allow 15. Pay `ceil(value, 6 decimals)`, never less than due.

### How default works

1. After `NextPaymentDueDate`, the broker may `LoanManage tfLoanImpair`. This is a paper loss on the vault and pulls the due date to now.
2. After the due date plus `GracePeriod`, the broker may `LoanManage tfLoanDefault`.
3. On default, cover drawn = min(DebtTotal × CoverRateMinimum × CoverRateLiquidation, defaulted amount). The rest is a realized loss: `AssetsTotal` drops.

The XRPL itself moves no collateral. That is our job, below.

### Collateral design (our layer)

- **Locking.** The borrower creates an `EscrowCreate` of GPU shares to the broker account, with a PREIMAGE-SHA-256 `Condition` only Moonshift knows. `CancelAfter` is set past maturity as the borrower's safety valve. The LoanSet `Data` field carries the escrow sequence, and the escrow carries a `MS_COLLATERAL` memo, so loan and escrow link both ways.
  - Share issuer flag: `asfAllowTrustLineLocking`.
  - The broker needs a share trust line.
- **Repay: prompt release.** One `Batch` with `tfAllOrNothing`, containing `EscrowFinish` (shares to the broker) plus a `Payment` returning the shares to the borrower. It's atomic, so the borrower is whole within one ledger and never waits for `CancelAfter`. This fixes the old testnet bug where repaid borrowers waited for CancelAfter.
  - Tradeoff: the borrower trusts Moonshift to submit the release. `CancelAfter` caps that trust in time.
  - The alternative, escrowing to the borrower, would make seizure on default impossible.
- **Default or liquidation.** `EscrowFinish` to the broker keeps the shares. The broker can sell them on the DEX and top up first-loss cover with `LoanBrokerCoverDeposit`, so collateral recovery refills cover.
- **Margin call.** An on-ledger memo (`MS_MARGIN_CALL`) from broker to borrower. Phase 3 also tests `tfLoanImpair` before the due date as the on-ledger "margin call" state. The xrpl.org sample implies impairment needs a late payment; still to verify.

## Limits and open items

- Devnet can be reset at any time. `setupNetwork` must rebuild everything and be safe to rerun (Phase 2).
- Faucet funding per account is enough XRP for reserves (vault, broker, loans, escrows, trust lines).
- Testnet has no lending, so the existing escrow loans on testnet remain the fallback if devnet is down.
- Liquidating **before** the due date cannot default the XLS-66 loan, because default needs due date plus grace. The plan is impair first, so default becomes possible after `GracePeriod`. To verify in Phase 3.

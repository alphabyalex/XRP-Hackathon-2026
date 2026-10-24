# @moonshift/xrpl

On-chain XRP Ledger integration library and toolchain for Moonshift. Built with `xrpl.js` 5.3 for XRPL **devnet** (XLS-65 vaults and XLS-66 loans) and **testnet** (the original escrow loans). `NETWORK=devnet|testnet` picks the network; mainnet is never used.

This package provides the single source of truth for all on-ledger primitives, tokens, DEX order books, escrowed loans, automated dividends, and telemetry oracles. It exposes pure TypeScript library functions consumed directly by `apps/api`.

---

## XRPL Features Status (checked 2026-10-24, rippled 3.4.1)

| Feature | devnet | testnet | Used for |
| :--- | :--- | :--- | :--- |
| `LendingProtocol`, `LendingProtocolV1_1` | YES | no | XLS-66 loan brokers and loans |
| `SingleAssetVault` | YES | no | XLS-65 vault holding TDX |
| `MPTokensV1` | YES | YES | Vault share tokens |
| `BatchV1_1` | YES | YES | Dividends, atomic collateral release |
| `TokenEscrow` | YES | YES | GPU shares locked as loan collateral |
| `Credentials`, `PermissionedDomains`, `PermissionedDEX` | YES | YES | Permissioned shares |
| `PermissionDelegationV1_1` | YES | YES | Delegated signing |
| `PriceOracle` | YES | YES | NAV, slot price and utilization per GPU |

Run `NETWORK=devnet npm run xrpl:features` (or testnet) to query live status.

---

## Environment Variables

All secrets live in `.env` at the repository root and are never committed or printed.

```bash
# Network
NETWORK=devnet          # devnet (lending) or testnet. Code default is testnet.
DEVNET_WSS=             # optional devnet override (Quicknode has no devnet)
XRPL_WSS=wss://s.altnet.rippletest.net:51233
QUICKNODE_WSS=          # testnet only; contains a token, never printed

# Devnet accounts use DEVNET_<NAME>_SEED (e.g. DEVNET_ALICE_SEED)

# Account Seeds (generated/managed by setupNetwork)
TDX_ISSUER_SEED=
SHARE_ISSUER_SEED=
CONTRACT_ISSUER_SEED=
TREASURY_GPU_A_SEED=
TREASURY_GPU_B_SEED=
PROTOCOL_FEES_SEED=
LENDING_POOL_SEED=
ORACLE_SEED=
ALICE_SEED=
BOB_SEED=
CAROL_SEED=
DEV_SEED=
```

Public addresses are committed in `contracts/accounts.<network>.json`. Lending round IDs (vault, loan broker, pseudo-accounts, dates) are in `contracts/lending.devnet.json`, and loan to collateral links in `contracts/collateral.devnet.json` (public, rebuildable from the ledger).

---

## Key Rules and Algorithms

1. **Algorithm Derivation Bug Guard**:
   `xrpl.Wallet.fromSeed` defaults to `ed25519`. Seeds not starting with `sEd` are secp256k1 and derive the wrong address. All wallet initialization in `src/wallets.ts` selects `ECDSA.ed25519` for seeds starting with `sEd` and `ECDSA.secp256k1` otherwise.
2. **Account Sequence Serialization**:
   All transaction submissions serialize per account through an in-process queue in `src/client.ts` (`withAccountLock`) to avoid sequence collisions under concurrent requests.
3. **Escrow Rules for Tokens**:
   - Both `TDX_ISSUER` and `SHARE_ISSUER` have `asfDefaultRipple` and `asfAllowTrustLineLocking` (SetFlag 17) enabled.
   - Crypto-conditions use ASN.1 DER PREIMAGE-SHA-256 formatting.
   - Escrows must have `CancelAfter` and `Condition`.

---

## Public Library Surface (A9.1)

### `setupNetwork(): Promise<AccountsFile>`
- **Behavior**: Idempotently funds all 12 accounts via testnet faucet, sets required issuer flags, establishes trustlines, mints initial supplies (1,000 GPA, 1,000 GPB, 200 HRA, 200 HRB, 10,000 TDX to personas/pool), and posts initial DEX offers. Writes public addresses to `contracts/accounts.testnet.json`.
- **Failure Modes**: Network timeout or faucet rate limiting. Automatically recovers on rerun.

### `getBalances(account: AccountName): Promise<Balances>`
- **Behavior**: Queries XRP and trustline token balances via `getXrpBalance` and `account_lines`.
- **Failure Modes**: Account not yet funded on ledger (returns 0.000000).

### `getHolders(gpuId: GpuId): Promise<Holder[]>`
- **Behavior**: Queries `account_lines` on `SHARE_ISSUER` for `GPA` or `GPB`, excluding treasuries and issuers. Returns list of external holders with their positive balances.

### `listShareOffers(gpuId: GpuId): Promise<Offer[]>`
- **Behavior**: Returns active order book sell offers for the GPU's share code via `book_offers`.

### `buyShares(p: BuySharesParams): Promise<TxResult>`
- **Behavior**: Places an `OfferCreate` with `tfImmediateOrCancel` crossing resting treasury offers up to `maxPricePerShare`.
- **Failure Modes**: Returns result `tecKILLED` if price cap is exceeded or liquidity is insufficient.

### `sellShares(p: SellSharesParams): Promise<TxResult>`
- **Behavior**: Places a resting `OfferCreate` selling shares for TDX.

### `listContractOffers(gpuId: GpuId): Promise<Offer[]>`
- **Behavior**: Returns active order book sell offers for compute slot tokens via `book_offers`.

### `buyContracts(p: BuyContractsParams): Promise<TxResult>`
- **Behavior**: Places an `OfferCreate` with `tfImmediateOrCancel` crossing treasury compute contract offers.

### `redeemContracts(p: RedeemContractsParams): Promise<RedeemContractsResult>`
- **Behavior**: Sends contract tokens back to `CONTRACT_ISSUER` with hex Memo `{ type: "MS_REDEEM", gpuId, slotStart, slots }`. Paying an IOU back to its issuer burns the token.
- **Return**: Includes `redemptionId` equal to the transaction hash.

### `payForInference(p: PayForInferenceParams): Promise<TxResult>`
- **Behavior**: Sends TDX payment from buyer to GPU treasury with hex Memo `{ type: "MS_CREDITS", gpuId }`.

### `payDividends(p: PayDividendsParams): Promise<TxResult[]>`
- **Behavior**: Groups hosting fee and shareholder payouts into atomic `Batch` transactions (up to 8 inner Payments each) with `tfAllOrNothing`, `tfInnerBatchTxn`, `Fee: "0"`, and consecutive sequences.
- **Fallback**: Automatically falls back to sequential Payments if `Batch` execution fails.

### `openLoan` / `repayLoan` / `settleLoan` (compatibility names)
Same names and shapes as before; behavior depends on `NETWORK`:
- **devnet**: `openLoan` opens an XLS-66 loan (single bullet payment at `LOAN.aprBps`) via `openLendingLoan`. `repayLoan` pays it off, releases the collateral in one Batch and deletes the loan. `settleLoan` liquidates (seize collateral, default when the ledger allows).
- **testnet**: the original escrow loans. `repayLoan` now also **releases the collateral immediately** (Batch: EscrowFinish + return shares) instead of waiting for `CancelAfter`. `settleLoan` keeps the old paths as fallbacks.

### `publishOracle(p: PublishOracleParams): Promise<TxResult>`
- **Behavior**: Publishes NAV, GPU slot price, and utilization percentage to the ledger via native `OracleSet` with Scale 4.

### `subscribe(accounts: string[], onTx: (tx: unknown) => void): Promise<() => void>`
- **Behavior**: Subscribes to live validated transaction stream for given accounts and returns an unsubscribe cleanup function.

---

## Lending (devnet): XLS-65 vaults + XLS-66 loans + GPU-share collateral

Findings and tx hashes: `docs/SPIKE_DEVNET_LENDING.md`. The Moonshift broker is the `LENDING_POOL` account. It owns every vault and loan broker, because only the vault owner may run `LoanBrokerSet`.

**Rounds.** LendingProtocolV1_1 only lets a new broker sit on a closed-ended vault, so lending runs in rounds:

| Phase | Deposits | Withdrawals | New loans |
| :--- | :--- | :--- | :--- |
| subscription | yes | yes | no |
| investment | no | no | yes |
| redemption | no | yes | no |

`setupNetwork` keeps one round investing (borrowers draw now) and the next round subscribing (lenders deposit now).

**Collateral (our layer; XLS-66 has none).** The borrower escrows GPU shares to the broker under a PREIMAGE-SHA-256 condition. The preimage is `HMAC(broker key, nonce)` with a public nonce, so only the broker can finish the escrow and nothing secret is stored.
- **Repay**: one all-or-nothing Batch (EscrowFinish + Payment back), so the shares return in the same ledger. Tradeoff: the borrower trusts Moonshift to submit it. `CancelAfter` (maturity + grace + 1 hour) caps that trust, because after it the borrower can cancel alone.
- **Liquidate**: EscrowFinish to the broker (`MS_LIQUIDATION` memo).

**Ledger rules we work around (verified on devnet):**
- Only the borrower can `LoanPay`.
- The full-payment flag is refused with one payment left (`tecKILLED`).
- Impair is refused before the due date (`tecTOO_SOON`).
- Default needs due date + grace.
- An overpayment must include the current installment.
- Ledger numbers can exceed IOU precision, so payments round up to 6 decimals (`ceil6`).

| Function | What it does |
| :--- | :--- |
| `createVault`, `depositToVault`, `withdrawFromVault`, `getVault`, `getVaultSummary`, `getVaultShares` | XLS-65 vault lifecycle and state (assets, utilization, share price, lender APY from open loans) |
| `setupLoanBroker`, `depositCover`, `getLoanBroker` | XLS-66 broker with first-loss cover (defaults: 10% minimum cover, 50% drawn on default, 1% management fee) |
| `createRound`, `currentRound`, `findRound`, `pruneRounds`, `ensureLendingRounds` | Round bookkeeping in `contracts/lending.<network>.json` |
| `openLendingLoan` | Escrow shares, then LoanSet (broker signs, borrower countersigns). Principal moves vault to borrower. Overpayment allowed so a margin call can be cured. |
| `repayLendingLoan` | `mode: "next"` pays one installment, `mode: "full"` pays off, releases the collateral (Batch) and deletes the loan |
| `prepayLoan` | Installment plus extra principal (margin call cure) |
| `marginCall` | `MS_MARGIN_CALL` memo (1 drop) from broker to borrower |
| `impairLoan`, `unimpairLoan` | LoanManage, only once a payment is late |
| `liquidateLoan`, `defaultLoan` | Seize collateral now; default the XLS-66 loan once due date + grace has passed |
| `getLedgerLoan`, `listLedgerLoans`, `findCollateral` | Loans read from the ledger (broker pseudo-account objects) with live collateral state |

On-ledger memo types:
- `MS_COLLATERAL`: escrow.
- `MS_LOAN_DISBURSE`: LoanSet.
- `MS_REPAY`: LoanPay, with `onTime`.
- `MS_MARGIN_CALL`.
- `MS_COLLATERAL_RELEASE`: repaid, NOT a liquidation.
- `MS_LIQUIDATION`.

---

## CLI Scripts

```bash
# Feature flags on the active network
NETWORK=devnet npm run xrpl:features

# Idempotent full world build (accounts, tokens, DEX, oracle, lending rounds). Safe to rerun.
NETWORK=devnet npm run xrpl:setup

# End-to-end smoke; on devnet it also runs the full lending cycle
NETWORK=devnet npm run xrpl:smoke

# Lending cycle only (deposit, open, pay, margin call, cure, payoff, liquidate, default, withdraw)
NETWORK=devnet npm run smoke:lending -w packages/xrpl

# One-off spike with fresh faucet wallets (docs/SPIKE_DEVNET_LENDING.md)
npm run spike:lending -w packages/xrpl

# Unit tests (no network)
npm run test:xrpl
```

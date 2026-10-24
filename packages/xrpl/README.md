# @moonshift/xrpl

On-chain XRP Ledger integration library and toolchain for Moonshift. Built with `xrpl.js` for the XRPL Testnet.

This package provides the single source of truth for all on-ledger primitives, tokens, DEX order books, escrowed loans, automated dividends, and telemetry oracles. It exposes pure TypeScript library functions consumed directly by `apps/api`.

---

## XRPL Testnet Features Status

Verified against `wss://s.altnet.rippletest.net:51233`:

| Feature | Enabled | Supported | Description |
| :--- | :--- | :--- | :--- |
| `BatchV1_1` | YES | YES | Atomic batch transaction execution (used for multi-payout dividends) |
| `TokenEscrow` | YES | YES | Native IOU trustline locking in escrows (used for share-backed loans) |
| `Credentials` | YES | YES | On-ledger credential issuance and validation |
| `PermissionedDomains` | YES | YES | Domain-restricted ecosystem definitions |
| `PermissionedDEX` | YES | YES | Permissioned trading books with credential checks |
| `PermissionDelegationV1_1` | YES | YES | Delegated signing authority |
| `PriceOracle` | YES | YES | Native on-ledger OracleSet price and metric publishing |

Run `npm run xrpl:features` to query the live network status at any time.

---

## Environment Variables

All secrets live in `.env` at the repository root and are never committed or printed.

```bash
# Network Endpoint
XRPL_WSS=wss://s.altnet.rippletest.net:51233
QUICKNODE_WSS= # Optional sponsor RPC override

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

Public addresses are committed in `contracts/accounts.testnet.json`.

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
- **Behavior**: Sends contract tokens back to `CONTRACT_ISSUER` with hex Memo `{ type: "GB_REDEEM", gpuId, slotStart, slots }`. Paying an IOU back to its issuer burns the token.
- **Return**: Includes `redemptionId` equal to the transaction hash.

### `payForInference(p: PayForInferenceParams): Promise<TxResult>`
- **Behavior**: Sends TDX payment from buyer to GPU treasury with hex Memo `{ type: "GB_CREDITS", gpuId }`.

### `payDividends(p: PayDividendsParams): Promise<TxResult[]>`
- **Behavior**: Groups hosting fee and shareholder payouts into atomic `Batch` transactions (up to 8 inner Payments each) with `tfAllOrNothing`, `tfInnerBatchTxn`, `Fee: "0"`, and consecutive sequences.
- **Fallback**: Automatically falls back to sequential Payments if `Batch` execution fails.

### `openLoan(p: OpenLoanParams): Promise<OpenLoanResult>`
- **Behavior**: Generates a 32-byte secret preimage, creates a `PREIMAGE-SHA-256` escrow locking borrower shares to `LENDING_POOL`, and disburses TDX principal from the lending pool.
- **Return**: `{ loanId, escrowTx, disburseTx }`.

### `repayLoan(p: { loanId: string }): Promise<TxResult>`
- **Behavior**: Borrower sends principal in TDX to `LENDING_POOL` with Memo `{ type: "GB_REPAY", loanId }`.

### `settleLoan(p: { loanId: string }): Promise<TxResult>`
- **Behavior**:
  - If repaid: Submits `EscrowCancel` returning shares to borrower.
  - If defaulted: Submits `EscrowFinish` with crypto-condition fulfillment, claiming shares to `LENDING_POOL`.

### `publishOracle(p: PublishOracleParams): Promise<TxResult>`
- **Behavior**: Publishes NAV, GPU slot price, and utilization percentage to the ledger via native `OracleSet` with Scale 4.

### `subscribe(accounts: string[], onTx: (tx: unknown) => void): Promise<() => void>`
- **Behavior**: Subscribes to live validated transaction stream for given accounts and returns an unsubscribe cleanup function.

---

## CLI Scripts

```bash
# Check testnet feature flags
npm run xrpl:features

# Idempotent full network provisioning
npm run xrpl:setup

# End-to-end smoke test across all operations
npm run xrpl:smoke
```

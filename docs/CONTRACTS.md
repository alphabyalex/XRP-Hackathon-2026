# Moonshift contracts

Source of truth, together with `contracts/*.json` (example payloads) and
`packages/shared/src/types.ts` (TypeScript types). If you change a contract,
update all three in the same PR and tell the team.

No em dashes in anything here, keep it plain.

---

## Requests from apps/web (frontend rebuild, CLAUDE_NOTES_3_FRONTEND.md)

Frontend is not allowed to edit apps/api directly. Logging needs here instead.

- **Pre-trade contract price quote.** `POST /contracts/buy` returns only a
  `TxResult`, no amount. The trade panel needs a price per slot to show
  before the user commits. Until this exists, apps/web estimates it as
  `revenue24h / 288` (see `apps/web/src/lib/economics.ts`, marked MOCK).
  Would be solved by something like `GET /gpus/:id/quote?kind=contract&slots=N`.
- **7 day price history.** No endpoint returns historical share price.
  apps/web generates a deterministic mock series client side for the 7 day
  chart on `/gpu/[id]` (marked `// MOCK: replace when /gpus/:id/history exists`).
- **24h of calendar history.** `GET /gpus/:id` calendar currently only
  reflects forward bookings (compute mock has no history). apps/web pads
  missing past slots with idle, per CLAUDE_NOTES_3_FRONTEND.md section 4.
  Real 24h history here would remove the need for that padding.
- **Partial-LTV borrowing.** `POST /loans/open` always lends at max LTV
  (`LOAN.maxLtvBps`, 50%), there is no parameter for a smaller amount. The
  borrow panel's amount slider is a preview only; the actual Borrow button
  always requests max LTV and shows the real returned principal. Would need
  an optional `principal` or `ltvBps` field on the request.
- **Redeem has no tx hash in its response.** `POST /contracts/redeem` returns
  `{ redemptionId, bookingId, slotStart, slotEnd }`, no `hash`, even though
  it burns a contract token on ledger internally. The portfolio page's
  Redeem toast shows the redemptionId instead of a tx hash. Would be solved
  by adding `hash`/`explorerUrl` (or a full `TxResult`) to the response.

---

## Shared constants (`packages/shared/src/constants.ts`)

```ts
export const BRAND = { name: "Moonshift", tagline: "Own the GPU. Earn around the clock." };
export const XRPL_WSS = "wss://s.altnet.rippletest.net:51233";
export const STABLE = { code: "TDX", display: "USDC (test)", decimals: 6 };
export const GPUS = [
  { id: "gpu-a", label: "GPU A", hw: "NVIDIA T4 16GB (AWS g4dn.xlarge)", model: "Qwen/Qwen3-1.7B", shareCode: "GPA", contractCode: "HRA", sharesTotal: 1000 },
  { id: "gpu-b", label: "GPU B", hw: "second g4dn.xlarge or SIMULATED", model: "Qwen/Qwen3-1.7B", shareCode: "GPB", contractCode: "HRB", sharesTotal: 1000 },
];
export const SLOT_MINUTES = 5; // 1 contract token = 1 slot; 5 min demo, 60 production
export const HOSTING_FEE_BPS = 1500;   // 15% placeholder
export const RESERVE_BPS = 500;        // 5% of net revenue kept in treasury
export const LOAN = { maxLtvBps: 5000, aprBps: 1000, demoTermMinutes: 10, liquidationLtvBps: 6500 };
export const PORTS = { web: 3000, api: 4000, compute: 5000, pricing: 6000 };
```

Money units: stablecoin amounts are decimal strings with at most 6 decimals
(`"12.500000"`), never floats. XRP amounts are drops strings. Times are ISO
8601 UTC strings. IDs are strings.

Explorer link format: `https://testnet.xrpl.org/transactions/<hash>`

---

## XRPL accounts (A8)

Created by Tharun's setup script (`packages/xrpl`'s `setupNetwork()`). Seeds
only ever live in `.env` (gitignored). Public addresses go into the committed
`contracts/accounts.testnet.json` since addresses are public.

- **Issuers:** `TDX_ISSUER` (issues TDX stablecoin), `SHARE_ISSUER` (issues GPA, GPB), `CONTRACT_ISSUER` (issues HRA, HRB).
- **Treasuries:** `TREASURY_GPU_A`, `TREASURY_GPU_B`. Hold unsold shares/contracts, receive revenue, pay dividends.
- **System accounts:** `PROTOCOL_FEES` (hosting fee), `LENDING_POOL` (funds loans, receives defaulted collateral), `ORACLE` (posts price oracles).
- **Personas:** `ALICE`, `BOB`, `CAROL` (shareholders), `DEV` (buys inference and contracts).
- **Env var names:** `XRPL_WSS`, then `<ACCOUNT>_SEED` for each account (e.g. `TDX_ISSUER_SEED`, `ALICE_SEED`).

---

## A9.1 `packages/xrpl` (TypeScript library, owner Tharun, consumer `apps/api`)

Every write returns `TxResult = { hash, result, validated, explorerUrl }`.
Every function loads wallets from env internally by `AccountName`.

```ts
setupNetwork(): Promise<AccountsFile>
getBalances(account: AccountName): Promise<{ xrp: string; tokens: Record<string,string> }>
getHolders(gpuId: GpuId): Promise<{ account: string; shares: string }[]>   // excludes treasury and issuer
listShareOffers(gpuId: GpuId): Promise<Offer[]>
buyShares(p: { buyer: AccountName; gpuId: GpuId; qty: string; maxPricePerShare: string }): Promise<TxResult>
sellShares(p: { seller: AccountName; gpuId: GpuId; qty: string; pricePerShare: string }): Promise<TxResult>
listContractOffers(gpuId: GpuId): Promise<Offer[]>
buyContracts(p: { buyer: AccountName; gpuId: GpuId; qty: string; maxPrice: string }): Promise<TxResult>
redeemContracts(p: { holder: AccountName; gpuId: GpuId; qty: string; slotStart: string }): Promise<TxResult & { redemptionId: string }>
payForInference(p: { payer: AccountName; gpuId: GpuId; amount: string; memo: string }): Promise<TxResult>
payDividends(p: { gpuId: GpuId; payouts: { account: string; amount: string }[]; hostingFee: string }): Promise<TxResult[]>
openLoan(p: { borrower: AccountName; gpuId: GpuId; collateralShares: string; principal: string; dueAt: string }): Promise<{ loanId: string; escrowTx: TxResult; disburseTx: TxResult }>
repayLoan(p: { loanId: string }): Promise<TxResult>
settleLoan(p: { loanId: string }): Promise<TxResult>
publishOracle(p: { gpuId: GpuId; navPerShare: string; gpuHourPrice: string; utilizationPct: string }): Promise<TxResult>
subscribe(accounts: string[], onTx: (tx: unknown) => void): Promise<() => void>
```

Key verified facts (see A10 below): `Wallet.fromSeed()` algorithm bug, escrow
expiration rules, DEX auto-crossing, multisig pattern, PriceOracle asset code
length, RLUSD escrow blocked. Trust these, don't re-derive them.

---

## A9.2 `services/compute` (Python FastAPI :5000, owner Kristian)

- `POST /v1/chat/completions`: OpenAI-compatible body + header `X-MS-Buyer: <account>`, optional `X-MS-Booking: <redemptionId>`. Returns OpenAI-compatible body + `x_ms: { request_id, gpu_id, model, input_tokens, output_tokens, charge, routed_reason, simulated }`. On rejection: HTTP 409/503 `{ error: { code, message } }`, codes `GPU_BOOKED | NO_ELIGIBLE_GPU | INSUFFICIENT_RUNWAY | PRICE_CAP_EXCEEDED | UPSTREAM_ERROR`.
- `GET /gpus`: `[{ id, state, model, simulated, tokens_per_sec, utilization_pct_1h }]`, state is `READY|SERVING|DRAINING|BOOKED|OFFLINE`.
- `GET /gpus/{id}/calendar?from=&to=`: `[{ start, end, kind, ref }]`, kind is `BOOKED|INFERENCE|HOLD`.
- `POST /bookings` (internal): `{ gpu_id, slot_start, slots, redemption_id, holder }` -> `{ booking_id }`, or 409 `SLOT_TAKEN`.
- Usage event: compute POSTs to api `POST /internal/usage`: `{ request_id, gpu_id, buyer, booking_id|null, input_tokens, output_tokens, charge, started_at, finished_at }`. Booked-slot requests have `charge: "0"`.

---

## A9.3 `services/pricing` (Python FastAPI :6000, owner Lucy)

- `GET /rates/inference?gpu_id=` -> `{ input_per_mtok, output_per_mtok, base_fee, currency: "TDX", valid_until, inputs }`.
- `GET /price/contract?gpu_id=&slot_start=` -> `{ price_per_slot, slot_minutes, reference_hourly_usd, components, valid_until, sources }`.
- `GET /nav?gpu_id=` -> `{ nav_per_share, treasury_cash, pv_future_net, utilization_assumption, trailing_revenue_24h, implied_yield_pct, inputs }`.
- `POST /dividends/propose`: `{ gpu_id, period_start, period_end, gross_revenue, holders }` -> `{ hosting_fee, reserve, distributable, payouts, dust, explanation, risk_flags }`.
- `POST /loans/quote`: `{ gpu_id, shares }` -> `{ collateral_value, max_principal, apr_bps, liquidation_value, term_minutes }`.
- `POST /agent/explain`: `{ context: "dividend"|"nav"|"loan", data }` -> `{ text, risk_flags }`. Bedrock-generated, deterministic fallback when `MOCK=1` or Bedrock fails.

---

## A9.4 `apps/api` (Express :4000, owner Alexander)

Public reads:
- `GET /gpus`: merges compute state + pricing NAV + share price + holders count.
- `GET /gpus/:id`: adds calendar, recent requests, revenue.
- `GET /portfolio/:account`
- `GET /tx`: recent tx log with explorer links.

Public writes:
- `POST /shares/buy` `{ buyer, gpuId, qty }`
- `POST /shares/sell` `{ seller, gpuId, qty, price }`
- `POST /contracts/buy` `{ buyer, gpuId, qty }`
- `POST /contracts/redeem` `{ holder, gpuId, qty, slotStart }`
- `POST /inference/chat`: proxies to compute with buyer `DEV` or the selected persona.
- `POST /loans/open`
- `POST /loans/:id/repay`

Admin (requires `ADMIN_KEY`):
- `POST /admin/dividends/propose` `{ gpuId }`
- `POST /admin/dividends/:id/approve`
- `POST /admin/oracle/publish`
- `POST /admin/demo/reset`
- `POST /admin/sim/start|stop`

Internal (requires `X-MS-Internal-Key`):
- `POST /internal/usage` (from compute)

Live updates: SSE at `GET /events`. Event types: `usage`, `tx`, `calendar`, `dividend`, `loan`.

SQLite tables: `usage_events`, `revenue_ledger`, `dividend_runs`, `payouts`,
`bookings`, `redemptions`, `loans`, `tx_log`, `holders_cache`. Schema lives in
`apps/api/src/db/schema.sql`.

---

## A10. Key XRPL facts the team already verified on testnet (trust these)

- **Wallet loading bug:** `Wallet.fromSeed()` defaults to ed25519. Seeds not starting with `sEd` are secp256k1 and derive the WRONG address. Always pass the algorithm based on seed prefix.
- **Escrow rules:**
  - IOU escrow requires the issuer flag `asfAllowTrustLineLocking` (AccountSet SetFlag 17).
  - EscrowCreate requires FinishAfter or Condition.
  - CancelAfter alone is rejected.
  - An escrow cannot be finished after CancelAfter.
  - Only PREIMAGE-SHA-256 conditions are supported.
  - The issuer cannot escrow its own token.
- **DEX:** a matching OfferCreate crosses automatically. There is no separate "take" transaction.
- **Multisig:** 2-of-3 works. Autofill once with the signer count, each signer signs the same prepared tx, then combine with `multisign()`.
- **PriceOracle (OracleSet):** works. Asset codes must be 3 chars or 40 hex.
- **RLUSD:** the testnet issuer has trustline locking off, so we use our own TDX token.
- **Not yet verified on testnet (verify early):** Batch (`BatchV1_1`, max 8 inner txs, inner txs need `tfInnerBatchTxn`, Fee "0", empty SigningPubKey), Credentials + Permissioned Domains + Permissioned DEX (offers carry `DomainID`; AMM not supported in permissioned books), Permission Delegation.
- **Payment channels:** XRP only.

## A11. What we will and will not claim

Will claim: real GPU, real model, real testnet transactions; booked time
preempts idle inference; dividends and loans settle on XRPL using native
features, no custom smart contracts.

Will NOT claim: that the blockchain proves the computation happened; that we
are integrated with OpenRouter or Liquid Inference (roadmap only); that
shares or dividends are real money; that we are first or only. Simulated
traffic and any simulated GPU are always labeled SIMULATED in the UI and API.

---

## Requests from Kristian's Risk Desk

The Risk Desk service owns loan quote calculations, monitoring decisions,
scenario analysis, and repeatable loan-book statistics. Its HTTP examples are
in `contracts/risk/`; it listens on port 7000 and uses `X-MS-Internal-Key` for
service-to-service calls.

Risk service routes are `POST /quote`, `GET /loans/health`,
`POST /scenarios/run`, `GET /book/stats?grade=`, and `GET /events` (SSE).
The stretch routes are `GET /rates/curve` and `GET /vault/health`. Quote money
fields are six-place decimal strings; LTV, APR, PD, and coverage are decimal
fractions. Stress and loan-book outputs are labeled simulated. The stress
route is available only in mock mode or when `DEMO_SHOCK_ENABLED=1`.

The keeper needs these API routes from Alex. Every route uses
`X-MS-Internal-Key`:

- `GET /internal/loans` returns open loan IDs, borrower, GPU ID, collateral
  shares, outstanding balance, APR, PD estimate, quote margin-call and
  liquidation LTV thresholds, and any existing margin-call timestamp. Amounts
  are decimal strings with six places. Each record has `loanId`, `borrower`,
  `gpuId`, `collateralShares`, `outstandingBalance`, `apr`, `pd`, `status`,
  `marginCallLtv`, `liquidationLtv`, `marginCallAt` (nullable), and
  `simulated` fields.
- `POST /internal/loans/{id}/margin-call` records an idempotent margin call
  with `{ idempotencyKey, observedLtv, threshold, occurredAt, reason }`.
- `POST /internal/loans/{id}/liquidate` records an idempotent liquidation
  request with `{ idempotencyKey, observedLtv, threshold, occurredAt,
  reason }`. The API and XRPL adapter own any ledger transaction.
- `GET /internal/oracle/{gpuId}/history?from=&to=` returns timestamped
  per-share oracle prices as decimal strings, shaped as
  `{ gpuId, prices: [{ timestamp, price }] }`.

The loan records returned to the keeper must retain the margin-call and
liquidation thresholds from the accepted risk quote. The Risk Desk does not
submit XRPL transactions itself.

---

## Requests from Alex (on-chain lane, packages/xrpl)

Lending now runs on **devnet** with XLS-65 vaults and XLS-66 loans. Details: `docs/SPIKE_DEVNET_LENDING.md` and `packages/xrpl/README.md`.

**For Lucy (services/credit): how to read Moonshift loan history.**

Memo types are JSON in `MemoData` with `MemoType` = hex("text/plain"):

| Memo `type` | Transaction | Meaning |
|---|---|---|
| `MS_COLLATERAL` | EscrowCreate (borrower to broker) | Shares locked as collateral |
| `MS_LOAN_DISBURSE` | LoanSet (broker signs, borrower is `Counterparty`) | Loan opened, principal from vault |
| `MS_REPAY` | LoanPay (borrower) | Repayment; `kind` is installment, payoff or prepay, and `onTime` is true or false |
| `MS_MARGIN_CALL` | Payment of 1 drop, broker to borrower | Margin call, with `ltv` and `threshold` |
| `MS_COLLATERAL_RELEASE` | Batch(EscrowFinish + Payment) by broker | Loan repaid, collateral returned. **This is NOT a liquidation**, even though the broker (LENDING_POOL) finishes the escrow. |
| `MS_LIQUIDATION` | EscrowFinish by broker | Collateral seized. Count this one as a liquidation. |

Also:
- A defaulted XLS-66 loan is a `LoanManage` with flag `tfLoanDefault` (0x00010000), submitted by the broker.
- Lending txs live on devnet, which Quicknode does not serve. For the `ms*` features, read devnet history from the public node (`https://s.devnet.rippletest.net:51234`). Devnet addresses are in `contracts/accounts.devnet.json`.
- The `LENDING_POOL` address differs per network: testnet is `contracts/accounts.testnet.json`, devnet is `contracts/accounts.devnet.json`.
- Your config comment says CancelAfter = dueAt + 120 s. On devnet it is maturity + grace + 3600 s, and repaid loans release collateral immediately, so CancelAfter is no longer a useful lateness signal. Use `MS_REPAY.onTime` and the loan's `NextPaymentDueDate`.

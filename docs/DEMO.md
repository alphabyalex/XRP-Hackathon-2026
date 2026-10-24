# Demo: 3 minutes, real devnet transactions

**Before the pitch (5 minutes ahead):**

```
npm run demo:reset    # clean devnet world: lending round open, prices at 5.00, ALICE holds GPU shares
npm run demo          # web :3000, api :4000 on devnet (+ Python services if 3.11+ is installed)
```

Open http://localhost:3000/borrow and http://localhost:3000/lend in two tabs. The app acts as **ALICE** (borrower) and **BOB** (lender).

**The one line to say:** Moonshift lends against fractional GPU shares. We underwrite with two things nobody else has: the GPU's real revenue history and the borrower's on-chain payment history. Loans are native XRPL loans (XLS-66) from a native XRPL vault (XLS-65). The collateral layer is ours, because XLS-66 has none.

## Click path

| Time | Where | Click | Say | What it proves |
|---|---|---|---|---|
| 0:00 | /lend | Point at "Lending now" and "Open for deposits" | "Lenders put USDC into a vault round. This round is lending; the next one is taking deposits." | XLS-65 closed-ended vaults on devnet, with live assets, utilization, first-loss cover |
| 0:20 | /lend | Deposit 100 | "That's a real VaultDeposit." Open the toast's tx. | Lender money is on-ledger |
| 0:35 | /borrow | Point at the credit profile | "We read her payment history. Top factors link to the transactions behind them." | Underwriting from on-chain history (Lucy's credit service, or its labeled simulation) |
| 0:55 | /borrow | The amount opens at the largest approved loan. Raise it by 10 and watch it decline, then put it back. | "Risk prices it live: APR, LTV against the margin call and liquidation lines, and how many times the GPU's dividends cover the payment." | Kristian's risk desk uses the GPU's revenue as the cash flow behind the collateral |
| 1:15 | /borrow | Read one line of the memo | "Bedrock explains the numbers. It never creates them." | Tharun's credit memo (or its labeled fallback) |
| 1:25 | /borrow | **Lock 100 GPA, borrow** (the approved amount) | "Two transactions: her shares go into an XRPL escrow, then a LoanSet that our broker signs and she countersigns." Open the tx. | Real XLS-66 LoanSet on devnet, with shares escrowed as collateral |
| 1:50 | /borrow | **Crash price to margin call** | "GPU prices drop. We publish the new price to the on-ledger oracle; the keeper sees LTV cross the line." | OracleSet plus an on-ledger MS_MARGIN_CALL. The alert text is the AI risk alert. |
| 2:10 | /borrow | **Crash price to liquidation** | "It keeps falling. The escrowed shares move to the lender side. First-loss cover absorbs part of the loss." | EscrowFinish seizes collateral. The XLS-66 default follows after the grace period. |
| 2:25 | /lend | Point at the loan book and grade stats | "Vault loss, cover drawn, and our simulated loan book by grade." | Loss accounting; simulated data is labeled |
| 2:35 | /borrow | **Restore price**, then a new loan, then **Pay off, release shares** | "The good path: she repays early with real interest, and her shares come back in the same ledger, atomically." | LoanPay + Batch(EscrowFinish + Payment) + LoanDelete |
| 2:55 | Any tx | Open one tx on devnet.xrpl.org | "Every step you saw is on the ledger." | |

If something stalls:
- Press **Restore price**. If no vault round is lending, run `npm run demo:reset`.
- Every service has a labeled fallback, so the path keeps working with any Python service down.

## Honest labels (say them if asked)

- **Network:** devnet, because XLS-65 and XLS-66 are not on testnet or mainnet yet. TDX is our test stablecoin, shown as USDC.
- **Credit profile:** labeled simulated unless Lucy's service is running. The "top factor" links are real devnet transactions of the borrower.
- **Risk and memo:** the quote is Kristian's model (a live service, or its identical TypeScript port). The memo is Bedrock when available, and otherwise a deterministic fallback, labeled as such.
- **Grade stats and the stress scenario's vault-loss numbers** are simulated. The oracle update, margin call, seizure, payoff and release are real transactions.
- **Default timing:** the ledger only allows the XLS-66 default after the due date plus grace. The seizure is immediate; the default lands later (the api retries in the background).

## Last full run

The run below was produced by `npm run demo:check` after `npm run demo:reset`, on devnet. All hashes open at devnet.xrpl.org.

Run on 2026-10-24 at about 14:20 EDT. It took 86 s end to end, and every step passed. The run before it, also from a fresh reset, passed too.

| # | Step | What it proves | Tx |
|---|---|---|---|
| 1 | Lender deposits 50 USDC (round 2) | XLS-65 VaultDeposit into a closed-ended vault | [D787F812](https://devnet.xrpl.org/transactions/D787F8129C0D7F448382194AEE441860024645918912EC04352CC3DCA276C76C) |
| 2 | Borrower escrows 100 GPA shares | GPU shares locked as collateral (EscrowCreate, MS_COLLATERAL) | [A044F0CF](https://devnet.xrpl.org/transactions/A044F0CF0D6AFDCBECDEFF7C50F063237807585C229CE7651D5215BDDF255E75) |
| 3 | Loan opens: 100 USDC from the vault | XLS-66 LoanSet, broker signs, borrower countersigns | [C9CE477E](https://devnet.xrpl.org/transactions/C9CE477EAE9529D25F8E6330EB607CEA0690CEC843F5BB8436CCE261ECA06638) |
| 4 | GPU price crash 5.00 to 1.95 | On-ledger PriceOracle update (OracleSet) | [38B554C2](https://devnet.xrpl.org/transactions/38B554C2B64DC51954B2982DE42F0E74F0FF2853B0E2E0DEE218457D07B47E9C) |
| 5 | Margin call at 51.3% LTV | MS_MARGIN_CALL memo on the borrower's ledger history | [4AE4354D](https://devnet.xrpl.org/transactions/4AE4354DCB9CF6ED02161B67B65C4BCDDBC8EE9F5F813D1DCED52892D579320F) |
| 6 | GPU price crash to 1.57 | OracleSet | [A82FD340](https://devnet.xrpl.org/transactions/A82FD340364890BA54A7CF992707697836975741D328B62087DB6CEACE840C32) |
| 7 | Liquidation at 63.8% LTV | Escrowed shares seized (EscrowFinish, MS_LIQUIDATION); XLS-66 default follows after grace | [D9C06D1F](https://devnet.xrpl.org/transactions/D9C06D1FE129AD486DA12FBA8302DA4E8EE069041884B2877FD623CA26607F66) |
| 8 | Oracle restored to 5.00 | OracleSet | [DDB43D65](https://devnet.xrpl.org/transactions/DDB43D65F3C0B1DB9CB5733E82DAA225B624516BCBF57F78D3643321D109855C) |
| 9 | Second loan: 60 USDC against 80 GPA | XLS-66 LoanSet | [3E68F509](https://devnet.xrpl.org/transactions/3E68F5097C4C939189FFDA7FB32A0E15CE6A4028E86E98A7F4E27386EC1C5BEB) |
| 10 | Borrower pays off early | XLS-66 LoanPay with real interest (MS_REPAY) | [2180EE6A](https://devnet.xrpl.org/transactions/2180EE6A8D682448ECD207ACDF62CC6B9CF51722065EC6AB9F629F13E7F6EC9A) |
| 11 | Collateral back in the same ledger | Batch (all or nothing): EscrowFinish + Payment back to borrower | [08C08BCB](https://devnet.xrpl.org/transactions/08C08BCB3E7D63CA580BB754F4FE2CB12272DA16890A3D0AF7A0A278EB9522FE) |
| 12 | Loan closed | XLS-66 LoanDelete | [4890B025](https://devnet.xrpl.org/transactions/4890B025D33EE06F97C508024A146925F1D9887D291931BB5BD748ED9FFF84DC) |

Sources in this run:
- Ledger: real devnet.
- Oracle: read live from the ledger.
- Credit, risk and memo: the api's built-in models, labeled simulated, because Python 3.11+ is not installed on the demo machine yet.

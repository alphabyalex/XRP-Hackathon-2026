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
| 0:55 | /borrow | Change the amount: 100 to 180 and back | "Risk prices it live: APR, LTV against the margin call and liquidation lines, and how many times the GPU's dividends cover the payment." | Kristian's risk desk uses the GPU's revenue as the cash flow behind the collateral |
| 1:15 | /borrow | Read one line of the memo | "Bedrock explains the numbers. It never creates them." | Tharun's credit memo (or its labeled fallback) |
| 1:25 | /borrow | **Lock 100 GPA, borrow 100 USDC** | "Two transactions: her shares go into an XRPL escrow, then a LoanSet that our broker signs and she countersigns." Open the tx. | Real XLS-66 LoanSet on devnet, with shares escrowed as collateral |
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

RUN_TABLE_PLACEHOLDER

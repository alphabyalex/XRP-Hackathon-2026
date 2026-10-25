# Demo: 3 minutes, real devnet transactions

**Before the pitch (5 minutes ahead):**

```
npm run demo:reset    # clean devnet world: lending round open, market quoted
npm run demo:prod     # production web :3000, api :4000 on devnet, Python services
```

Connect the presenter's Crossmark wallet (Testnet). The wallet is the user: it gets its own Moonshift account (10,000 USDC, 500 GPU-A, 200 GPU-B shares). Open /borrow and /lend in two tabs, and /admin/router in a third for the operator controls.

**Stress tests never touch the presenter's account.** Crash to margin call and crash to liquidation (on /admin/router) hit every loan on that GPU, and a liquidation stays in the borrower's credit record (it drops the score to grade E). Before pressing them, the presenter has no open loan on that GPU; show the stress on a loan opened by a second wallet (sign it in from a private window) or by the DEV account. If the presenter's account was hit anyway, use **Reset account for wallet** on /admin/router: the wallet gets a fresh account with the starting balance and no loan history.

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
| 1:50 | /admin/router | **Crash price to margin call** (a second wallet's or DEV's loan, not the presenter's) | "GPU prices drop. We publish the new price to the on-ledger oracle; the keeper sees LTV cross the line." | OracleSet plus an on-ledger MS_MARGIN_CALL. The alert text is the AI risk alert. |
| 2:10 | /admin/router | **Crash price to liquidation** (same loan) | "It keeps falling. The escrowed shares move to the lender side. First-loss cover absorbs part of the loss." | EscrowFinish seizes collateral. The XLS-66 default follows after the grace period. |
| 2:25 | /lend | Point at the loan book and grade stats | "Vault loss, cover drawn, and our simulated loan book by grade." | Loss accounting; simulated data is labeled |
| 2:35 | /admin/router, then /borrow | **Restore price**, then the presenter opens a new loan and presses **Pay off, release shares** | "The good path: she repays early with real interest, and her shares come back in the same ledger, atomically." | LoanPay + Batch(EscrowFinish + Payment) + LoanDelete |
| 2:55 | Any tx | Open one tx on devnet.xrpl.org | "Every step you saw is on the ledger." | |

If something stalls:
- Press **Restore price** on /admin/router. If no vault round is lending, run `npm run demo:reset`.
- The presenter's /borrow says "No approved amount": the account has a liquidation on record. Reset it from /admin/router.
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

## Router: run a task on our GPUs (2 minutes)

`npm run demo` also starts the order router on :7200. Tasks run only on Moonshift's own GPU-A and GPU-B (config/fleet.own.json), the GPUs whose shareholders the task pays. The external catalog (AWS, Azure, Google Cloud, Oracle, Lambda, RunPod, Vast.ai, CoreWeave) is the market benchmark: each GPU is priced at the cheapest on-demand offer for the same GPU. Open http://localhost:3000/admin/router in a second tab (not linked from the nav; enter the ADMIN_KEY if one is set).

**The one line to say:** Send a task with a price cap. The router places it on our GPUs at the market price, and if a GPU is taken back mid-task, the task resumes on the other GPU instead of restarting, and never costs more than the cap.

| Time | Where | Click | Say | What it proves |
|---|---|---|---|---|
| 0:00 | /admin/router | Market benchmark table and the fleet's "Priced from" column | "We price against the live market for the same GPU across eight clouds. A customer never pays more than renting a T4 elsewhere." | Multi-provider catalog as a pricing benchmark |
| 0:15 | /market | Run a task: the default inference batch. Point at the three options, then the estimate and the cap | "Three service levels on the same GPUs: Pausable at the AWS spot rate, Guaranteed at on-demand, Priority runs both GPUs at once for a 25% premium. Estimate, plus a 25% cap, set aside on the ledger." | Whole-job price and ETA per level from the router |
| 0:35 | /market | **Submit task** | "It is running on GPU-A and GPU-B." Open the set-aside link. | MS_ORDER Payment on devnet, live progress over SSE |
| 0:50 | /admin/router | **Reclaim** on GPU-A while the task runs | "GPU-A was just taken back with a warning window." | One reclaim path for manual, booking and cloud notices |
| 1:00 | /market | The line "Moved to GPU-B, resumed" | "It checkpointed inside the warning window and continued on GPU-B. Nothing restarted." | Resume, don't restart |
| 1:30 | /market | "Charged X USDC · Refunded Y USDC" | "Each GPU was paid for exactly the work it served, and the rest of the cap came back." | MS_SETTLE per GPU + MS_REFUND on devnet |
| 1:45 | /playground | Run a prompt | "The same GPUs answer the OpenAI-compatible API." | /v1/chat/completions through the router |

### Last router run (devnet)

Run on 2026-10-24 through apps/api with MOCK_XRPL=0, NETWORK=devnet. Order `ord_953c69de`, mode Cheapest, T4 only: it started on Azure spot (GPU-A3), was reclaimed at token 15, and resumed on AWS spot (GPU-A2) as one continuous reply (15 + 20 tokens, 0 restarts).

| # | Step | Tx |
|---|---|---|
| 1 | Buyer pays the quote to the order treasury (MS_ORDER) | [241C1E9C](https://devnet.xrpl.org/transactions/241C1E9C58E5C1FE673003E3F8EFD5F2124EC4943A9F793B4952E27D44DFFCD3) |
| 2 | GPU-A2 (AWS) paid for the 20 tokens it served (MS_SETTLE) | [CDCD8575](https://devnet.xrpl.org/transactions/CDCD85755FE7B4BB6A2AEB7D27A90466989CE0007886C92A1CC8B26471110EFB) |
| 3 | GPU-A3 (Azure) paid for the 15 tokens it served (MS_SETTLE) | [A7BA417B](https://devnet.xrpl.org/transactions/A7BA417BD9A48E14BE9C50372A46C33A3A6217C3A6613B01A2A1117F8105BDFA) |
| 4 | Unused amount refunded to the buyer (MS_REFUND) | [7A11B3BE](https://devnet.xrpl.org/transactions/7A11B3BE97C508A95D8941A308BA4C72713E60F4B028D491D6C4F3B6BC386BF2) |

Honest labels for the router: the fleet in the demo is the mock fleet (real prices from the catalog where collected, GPUs run in-process at each card's speed); external providers' GPUs are not launched unless AWS_LAUNCH=1 / EXTERNAL_LAUNCH=1. The benchmark in docs/ROUTER.md is a simulation.

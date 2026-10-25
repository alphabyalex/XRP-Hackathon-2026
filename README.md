# Moonshift

**Own a share of a GPU. Borrow against it. On the XRP Ledger.**

GPUs make money renting out compute. Moonshift splits real GPUs into shares on XRPL, so anyone can own one, earn from the work it does, and borrow against it without selling.

**Live app:** https://moonshift-protocol.vercel.app
Built for the XRPL Commons AI & Fintech Hackathon, New York, October 2026 (Lending & Borrowing track).

## How it works

- **Rent compute.** Customers send tasks, not time slots. Pick Cheapest, Balanced or Fastest, set a price cap, and the router places the task on the best GPU. If a GPU is reclaimed mid-task, the task moves and resumes. You pay what it actually used; the rest of the cap is refunded.
- **Own a GPU.** Every GPU is split into shares that trade on the XRPL DEX. 80% of each GPU's revenue goes to its shareholders as USDC payouts.
- **Borrow without selling.** Lock GPU shares as collateral and borrow USDC from a lending vault. Repay and the shares unlock instantly.
- **Lend.** Deposit USDC into a vault round. Loans are backed by locked shares plus a first-loss cover, and a keeper issues margin calls and liquidations onchain when a loan crosses its limits.

## What prices the risk

- **Your onchain history, read through Quicknode.** We read a borrower's full XRPL history (`account_tx`, `account_info`, `account_lines`, `account_objects`, `account_offers`), plus a live WebSocket subscription. That becomes a transparent credit score and grade.
- **The GPU's real revenue.** The cash flow behind the collateral.
- **A risk desk** turns both into the APR, the max loan and the margin call and liquidation lines.
- **Amazon Bedrock (Claude Haiku 4.5)** writes the credit memo in plain English, and sizes compute tasks from a description. 
- **Live AWS spot and on-demand GPU prices** feed the router and sit next to our price on every listing.

## Built on

- **XRPL devnet:**
  - XLS-65 single-asset vaults and XLS-66 loans;
  - token escrow for collateral, batch transactions, and the DEX for share trading.
- **Quicknode:** XRPL mainnet (read-only) and testnet, for credit data.
- **AWS:** Bedrock and live EC2 GPU pricing.
- **Akash Network:** the GPUs themselves (NVIDIA T4 serving Qwen2.5-1.5B-Instruct, more on the way).
- **The app:** Next.js web app, a TypeScript API, and Python services for the router, compute, pricing, risk and credit.

## Run it

    npm install
    cp .env.example .env    # add your keys
    npm run demo:prod       # web on :3000, API on :4000

## Team

Alexander Schuessler, Tharun Ekambaram, Lucy Zhang and Kristian Bridge.

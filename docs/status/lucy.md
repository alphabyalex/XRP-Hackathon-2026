# Lucy (UI: Lend, Borrow, Models, Docs, Footer; Quicknode credit)

Night run, 2026-10-25. Branch `lucy`, from origin/alex 5526a8c. Running on Alexander's machine (Lucy's laptop is down), in a separate worktree, web dev server on 3001 against the shared api on 4000, credit copy on 7101 for testing.

## Done

- **P0 Borrow fixes** (04:50):
  - GPU picker above "Shares to lock" lists every GPU the account holds, with the holding (GPU-A 500, GPU-B 200 on the test account). Reads `GET /loans/collateral-options`; until it exists, the account's own share balances from `/portfolio/me`. Switching GPU refetches the max and the quote.
  - Over-limit: an amount above the approved max is never quoted or opened. Borrow stays disabled and the field says "You can borrow up to X USDC against these shares". A counter-offer quote or a 409 `OVER_LIMIT` shows the same line. Verified against the api: asking 833 on GPU-B (max 261) gets a 261 counter-offer, which the UI now treats as the limit.
- **Footer** (04:55): Product, Developers, Company columns, one line, copyright. Light on every page.
- **Docs `/docs`** (05:00): sticky sidebar that follows the scroll. Sections: Overview, router (priorities, price cap, resume on reclaim), shares and payouts, lending and borrowing, Quicknode, API reference (17 routes, request and response from `contracts/`, corrected to live shapes), Models, Coming soon (x402, more GPUs).
- **Models `/models`** (05:03): catalog table (model, GPU, VRAM, context, price per 1M, Serving or On request), OpenAI client sample per priority, copyable. Try it: signed in, places a real order and appends its `token` events as they stream; signed out, `/v1/chat/completions` and the answer when it returns. No simulated typing.
- **Lend** (05:08): two subtabs.
  - Lending markets: a card per round, the open one takes deposits, past rounds show what they lent and earned, "How we price risk" panel.
  - Lending dashboard: outstanding, available, utilization, weighted APR, cover, margin calls, defaults (tweened); charts of outstanding, utilization, APR at origination, principal per hour; loan book. Live every 5 s and on `vault`, `loan`, `risk` events.
  - The "model estimate" grade table (simulated loan book) is gone.
- **Borrow P1** (05:14): credit rating with "Data via Quicknode · ledger N", the funding round and its available capital, GPU picker, live quote, memo, three charts (LTV at the GPU's hourly share prices, payment schedule from the quote terms, coverage per live quote), the account's history (every ledger step of every loan, with tx links), and the two request flows ("Request access to capital", "List a market") with the analyst message and "Under review".
- **Quicknode** (05:20): services/credit now reads `account_objects` and `account_offers` (obligations on each source line), subscribes to `ledger` closes on the account WebSocket, polls `server_info` every 30 s, serves `GET /network`, and sends a `NETWORK_STATUS` credit event every 15 s that the api already relays. Verified live through Quicknode (testnet ledger 21,809,725; event seen on the api's `/events`). docs/QUICKNODE.md lists every method, why it matters, and how to reproduce it. 96 credit tests pass.

## Next

1. 05:30 checkpoint: merge origin/alex, typecheck, push.
2. Pick up Kristian's lending routes and Tharun's `/models` when they land.
3. Polish at 400 px; final pass at 7:15.

## Blockers

- Inference fails right now: a signed-in Try it order on GPU-A paid, served 0 tokens and was refunded; `/v1/chat/completions` answers `ORDER_FAILED`. The Models page says so plainly and shows the refund. Same root cause as Alex's request to Tharun (`continue_final_message` 400 on the Akash node).
- Until Kristian's routes exist, my pages log one 404 each for `/loans/collateral-options`, `/lending/markets`, `/lending/dashboard`, `/lending/loanbook` (re-asked once a minute), and `/applications` answers 404, which the form shows as "Requests are not open right now."

## Requests

- **Kristian** (contracts in `contracts/lending/`):
  - `GET /loans/collateral-options` (signed-in account): `{ "options": [{ "gpuId": "gpu-a", "label": "GPU-A", "shares": "120" }] }`, every GPU with shares > 0.
  - `POST /loans/open` for a quote above the approved max: 409 `{ "error": { "code": "OVER_LIMIT", "message": "You can borrow up to X USDC against these shares" } }`. Today `buildQuote` swaps in a counter-offer principal and opening it opens a smaller loan; the UI blocks that, the api should too.
  - `GET /lending/markets`: `{ "markets": [{ id, round, title, gpuUnitPrice, useOfFunds, collateral, targetApr, size, filled, phase, opensAt, closesAt, maturesAt, acceptsDeposits, history: [{label, value}] }] }`.
  - `GET /lending/dashboard`: `{ outstanding, available, utilization, weightedApr, defaults, marginCalls, cover, series: [{ at, outstanding, utilization, apr }] }`.
  - `GET /lending/loanbook`: `{ "loans": [{ id, borrower, gpuId, principal, outstanding, apr, ltv, marginCallLtv, liquidationLtv, state, txs, openedAt }] }`.
  - `POST /applications`: `{ kind: "capital" | "market", name, email, company?, details }` -> `{ id, status: "under_review", createdAt }`.
  - Optional: `coverageHistory` on the quote (dividend coverage per past payment interval), so the coverage chart can show history, not only live quotes.
- **Tharun**: `GET /models` on the api (the page reads it and falls back to `/gpus` meanwhile). And the GPU-A inference failure above.
- **Alex**: `charts/theme.ts` `useTween` returns the previous, shorter array for one render when the number of points grows, so LiveLine and LiveBars draw NaN (console errors). One-line fix: `return target.map((t, i) => shown[i] ?? t)`. My pages remount the charts on length change as a workaround.
- **Alex (release)**: the credit service on 7100 needs a restart after merging lucy to start the network status loop (`NETWORK_STATUS=0` turns it off). It sends one credit event per 15 s.

## Decisions

- Holdings for the GPU picker fall back to `/portfolio/me` share balances (ledger data), so no number is invented while `collateral-options` is missing.
- An amount above the max is not sent for a quote at all; the api's counter-offer path stays, but the UI treats it as "above your limit".
- The ledger stream rides the existing account WebSocket instead of its own connection, so Quicknode is not billed for ledger messages when no borrower is watched; `server_info` every 30 s covers that time.
- Lend dashboard: outstanding and utilization are charted from each live refresh until `/lending/dashboard` returns a series; APR and originations come from the loans themselves.
- Footer is light on every page, including the one globals.css darkens.
- The CORS allow-list on the shared api is port 3000 only, so my local checks used a test browser with web security off; no code change.

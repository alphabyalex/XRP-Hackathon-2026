# Lucy (UI: Lend, Borrow, Models, Docs, Footer; Quicknode credit)

Night run, 2026-10-25. Branch `lucy`, from origin/alex 5526a8c. Running on Alexander's machine (Lucy's laptop is down), in a separate worktree, web dev server on 3001 against the shared api on 4000.

## Done

- 04:50 P0 Borrow fixes (2680957):
  - GPU picker above "Shares to lock" lists every GPU the account holds, with the holding. Reads `GET /loans/collateral-options`; until that route exists it uses the account's own share balances from `/portfolio/me` (real data either way). Switching GPU refetches the max and the quote.
  - Over-limit: an amount above the approved max is never quoted or opened. Borrow stays disabled and the field says "You can borrow up to X USDC against these shares". A quote that comes back with a counter-offer, or a 409 `OVER_LIMIT` from `POST /loans/open`, shows the same line. Locking more shares than held is blocked too.

## Next

1. Footer rebuild.
2. Docs page `/docs`.
3. Models page `/models` with a live Try it box.
4. Lend: Lending markets and Lending dashboard subtabs.
5. Borrow P1: dense layout, charts, history, two application flows.
6. Quicknode: account_objects, account_offers, server_info, ledger stream in services/credit.

## Blockers

- None yet.

## Requests

- **Kristian** (contracts in `contracts/lending/`, please by 5:15):
  - `GET /loans/collateral-options` (signed-in account): `{ "options": [{ "gpuId": "gpu-a", "label": "GPU-A", "shares": "120", "sharePrice": "1.23", "maxPrincipal": "40.00" }] }`. Every GPU with shares > 0, GPU-B included.
  - `POST /loans/open` with a quote whose principal is above the approved max: answer 409 `{ "error": { "code": "OVER_LIMIT", "message": "You can borrow up to X USDC against these shares" } }`. Never open a smaller loan than the borrower asked for (today `buildQuote` silently swaps in a counter-offer principal, and opening that quote opens the smaller loan; the UI now blocks it, the api should too).
  - `GET /lending/markets`: rounds with `{ id, title (what it finances), gpuUnitPrice, useOfFunds, collateral, targetApr, size, filled, phase, opensAt, closesAt, history? }`.
  - `GET /lending/dashboard`: `{ outstanding, available, utilization, weightedApr, defaults, marginCalls, cover, series: [{ at, outstanding, utilization, apr }] }`.
  - `GET /lending/loanbook`: `{ loans: [{ borrower, gpuId, principal, outstanding, apr, ltv, state, txs }] }`.
  - `POST /applications`: `{ kind: "capital" | "market", name, email, company?, details }` -> `{ id, status: "under_review", createdAt }`.
  - `GET /credit/network` (proxy to credit `GET /network`, which I am adding in services/credit): ledger index, fees and server_info read through Quicknode.
  - The `vault`, `loan` and `risk` SSE events: please keep them, the Lend dashboard listens for them.
- **Tharun**: `GET /models` exposed on the api (contract `contracts/compute/models.json` received, thanks). The Models page reads it and shows an empty state until it answers.

## Decisions

- Holdings for the GPU picker fall back to `/portfolio/me` share balances, which come from the ledger, so no number is invented while `collateral-options` is missing.
- An amount above the max is not sent for a quote at all; the counter-offer path in the api stays, but the UI treats it as "above your limit".

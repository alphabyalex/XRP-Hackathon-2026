# Runbook

How to run Moonshift locally. Keep this current as services go from mock to real.

## 1. Install

```
cd moonshift
npm install
```

services/compute and services/pricing are Python placeholders for now
(README only), nothing to install there yet.

## 2. Configure

```
cp .env.example .env
```

Fill in at minimum, to run everything in mock mode:
- `ADMIN_KEY` (any string, required for /admin/* routes)
- `INTERNAL_API_KEY` (any string, required for /internal/* routes)

Leave `MOCK_XRPL=1`, `MOCK_COMPUTE=1`, `MOCK_PRICING=1` as-is until the
corresponding real service is ready. Account seeds (`<ACCOUNT>_SEED`) are
only needed once MOCK_XRPL=0, filled in by Tharun's setup script.

## 3. Run

```
npm run dev
```

Starts apps/web (http://localhost:3000) and apps/api (http://localhost:4000)
together. Visit http://localhost:3000, it should show GPU-A and GPU-B with
mock numbers pulled live from apps/api.

Health check: `curl http://localhost:4000/health`

Routes:
- `/` landing page: hero, market window, schedule, 80 cents, borrow, developers.
- `/market` the two GPUs trading now, full page. `/marketplace` redirects here.
- `/gpu/[id]` one GPU's price, 24h schedule and trade panel, e.g. `/gpu/gpu-a`.
- `/portfolio` holdings, dividends received, redeemable contracts, open loans.
- `/borrow` open a loan against shares, or see the open one with a repay button and countdown.
- `/playground` the OpenAI-compatible code sample plus a live Try It box.

`?accent=moon` on any route switches the whole site to moon yellow.

## 4. Demo script (A3), once all lanes are real

1. Marketplace: GPU cards show share price, utilization, yield.
2. Buy shares: `POST /shares/buy`, see the tx hash and explorer link.
3. Idle inference: start the simulator (`POST /admin/sim/start`), then type
   one live prompt in the Playground. Revenue ticker moves.
4. Booked compute: `POST /contracts/buy` then `POST /contracts/redeem`.
   Watch the calendar flip to BOOKED and inference reroute to the other GPU.
5. Dividends: `POST /admin/dividends/propose`, read the explanation, then
   `POST /admin/dividends/:id/approve`. Holders get paid in one shot.
6. Loan: `POST /loans/open`, then either `POST /loans/:id/repay` before the
   due time, or let the demo timer expire to show default settlement.

## 5. Fallbacks

- Any service down: flip its `MOCK_*` env var back to 1, mock adapters return
  contract-shaped fake data so the rest of the demo still runs.
- `POST /admin/demo/reset` (requires `ADMIN_KEY`) clears all SQLite tables,
  resets the mock XRPL ledger and mock compute bookings, and stops the
  simulator. Use this between demo run-throughs.

## 6. Mock vs real

| Switch | 1 (default) | 0 |
|---|---|---|
| `MOCK_XRPL` | in-memory mock ledger in apps/api | calls packages/xrpl (real testnet) |
| `MOCK_COMPUTE` | in-memory mock GPU/bookings in apps/api | calls services/compute at `COMPUTE_URL` |
| `MOCK_PRICING` | deterministic placeholder numbers | calls services/pricing at `PRICING_URL` |

Flip one at a time and re-run the demo script to confirm nothing else broke.

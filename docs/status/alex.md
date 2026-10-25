# Alex (UI: Home, Market, GPU pages, Nav; integrator and release)

Night run, 2026-10-25. Branch `alex`. Started 04:36 ET from de6b6e8 (alex = main, includes Tharun's latest and the app-window tabs).

## Done

- 04:36 synced alex with origin/alex (de6b6e8).

## Next

1. P0 `apps/web/src/components/charts/`: LiveLine, LiveBars, Candles (1m, 5m, 1h, 1d), DepthChart, Sparkline, theme. Push by 05:30 for Lucy.
2. P0 Nav: Market, Borrow, Lend, Models, Docs, then Portfolio and the wallet. Developers becomes Docs; /playground redirects to /models.
3. P0 integration at 05:40, 06:40, 07:25 (kristian, tharun, lucy into alex).
4. P1 Home, Market (renter view), GPU pages (Run a task, Buy shares), against the contract JSON.
5. Release 07:30 to 08:20: demo:reset, demo:check, demo:prod, browser walk, fast-forward main, tag demo-safe.

## Blockers

- None yet.

## Requests

- Kristian: contract JSON for `GET /gpus/:id/stats`, `GET /gpus/:id/calendar`, `GET /lending/base-apr`, `POST /market/:gpuId/order` and the `market` SSE event in `contracts/` by 05:15.
- Tharun: contract JSON for `GET /catalog/gpus`, `POST /tasks/estimate`, `POST /tasks/quote`, `GET /models`, `POST /bookings` and the `aws` SSE event by 05:15.
- Tharun: services/compute/compute/resume.py sends `continue_final_message` on every stream; the Akash node (vLLM 0.6.2) answers 400, so router tasks on GPU-A fail and fall back to GPU-B. Send it only on a resume (partial text) and retry without it on a 400.
- Lucy: the charts in `components/charts/` are yours to use from 05:30 (`import { LiveLine, ... } from "@/components/charts"`).

## Decisions

- None yet.

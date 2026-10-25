# Alex (UI: Home, Market, GPU pages, Nav; integrator and release)

Night run, 2026-10-25. Branch `alex`. Started 04:36 ET from de6b6e8 (alex = main, includes Tharun's latest and the app-window tabs).

## Done

- 04:36 synced alex with origin/alex (de6b6e8).
- 04:39 P0 charts in `apps/web/src/components/charts/` (85cefc5): LiveLine, LiveBars, Candles (1m, 5m, 1h, 1d), DepthChart, Sparkline, theme. SVG, no dependencies, empty states, values tween.
- 04:40 P0 nav: Market, Borrow, Lend, Models, Docs, then Portfolio and the wallet. /playground redirects to /models (e6b3dc7).
- 04:41 App window blended into the page (no duplicate header), no model name in the GPU header, no "mock" on /admin/router (5526a8c).
- 04:50 Home (0d6d4be): live hero sentence with tweened numbers, rentals table (no vCPU or AWS columns, Status column: Available, Busy, Not connected), live AWS rate line from `/catalog/aws` and the `aws` event, human copy for "Working around the clock", tighter gaps, Reveal on every section, the code sample types itself out, and the Try panel asks GPU-A a new question every few seconds (real answers, cached per session, only answers GPU-A served are shown).
- 04:50 `usePolled(path, { ms, on })` in lib/liveData.tsx: polls a route every 2 to 5 s and refetches on named SSE events. The GPU map now refreshes every 5 s, not 30.
- 04:57 Market (e18df27): renter table from `GET /catalog/gpus` (location, card and VRAM, vCPU, RAM, storage, price per hour with GPU market and AWS prices under it, 24h change, free nodes, 24h utilization sparkline, "Rent a GPU"). Share table below it.
- 04:57 GPU page (e18df27): "Run a task" (default) with specs, "Describe your task" (`POST /tasks/estimate`, sliders ease to the size), task types, model picker (`GET /models`, serving only), live hardware quote (`POST /tasks/quote`), the router checkout for the real submit, and a 7-day booking calendar (`GET /gpus/:id/calendar`, `POST /bookings`). "Buy shares" (`?view=shares`) with candles, depth, 24h stats, order book, trades with ledger links and a buy / sell ticket (`POST /market/:gpuId/order`, falls back to /shares/buy and /shares/sell while that route is missing).

## Next

1. 05:30 checkpoint, 05:40 integration (kristian, tharun, lucy into alex).
2. Wire `GET /gpus/:id/stats` into Home, Market and Portfolio once Kristian's contract lands.
3. Browser check of Home, Market and GPU page at 1280 and 400.
4. Release 07:30 to 08:20: demo:reset, demo:check, demo:prod, browser walk, fast-forward main, tag demo-safe.

## Blockers

- Kristian's contracts (stats, base-apr, market order, market event) were not on origin/kristian at 04:54. The GPU page reads `/gpus/:id/stats` with the shape below and falls back to `/gpus/:id` fields until it answers.
- Tharun's routes (`/catalog/gpus`, `/catalog/aws`, `/models`, `/tasks/*`, `/bookings`, `/gpus/:id/calendar`) are contracts only so far. The UI shows loading or "not available" states until they answer.

## Requests

- Kristian: contract JSON for `GET /gpus/:id/stats`, `GET /lending/base-apr`, `POST /market/:gpuId/order` and the `market` SSE event. The UI already reads this stats shape (all optional, decimals as strings): `{ gpuId, price, change24hPct, volume24h, high24h, low24h, marketCap, holders, navPerShare, yieldPct, paidPerShare24h, bids: [{price, qty}], asks: [{price, qty}], trades: [{t, price, qty, side, hash, explorerUrl}], ticks: [{t, price, qty}], updatedAt }`. Order body: `{ side: "buy" | "sell", qty, price }`, returns the usual TxResult. Emit `market` on every fill or book change.
- Tharun: the router (`/router/quote`, `/router/orders`) still prices from the AWS index, while `/tasks/quote` and the catalog use the GPU market median. The GPU page shows both, so please make the router charge the `/tasks/quote` rate, or make `/tasks/quote` return the router's rate, so the two numbers match.
- Tharun: an option on `POST /v1/chat/completions` to pin `gpu-a` (for the Home showcase). Until then Home shows only answers whose `x_ms.gpus` includes GPU-A.
- Tharun: services/compute/compute/resume.py sends `continue_final_message` on every stream; the Akash node (vLLM 0.6.2) answers 400, so router tasks on GPU-A fail and fall back to GPU-B. Send it only on a resume (partial text) and retry without it on a 400.
- Lucy: the Home borrow card is your BorrowPanel. Please drive its chart from `GET /lending/base-apr` and let it move live (usePolled from `@/lib/liveData` works: `usePolled<T>("/lending/base-apr", { ms: 5000, on: ["loan"] })`).
- Lucy: the charts in `components/charts/` are yours to use (`import { LiveLine, ... } from "@/components/charts"`).

## Decisions

- Home rentals table lists only health-checked GPUs (a GPU that fails its check is not listed at all). "Not connected" is shown for a listed GPU whose compute state is OFFLINE.
- "Working around the clock" keeps its bars from the GPU's own usage history (`/gpus/:id`, last 20 hours and next 4), refreshed every 5 s. The calendar route only covers the future, so it feeds the 7-day booking grid on the GPU page instead.
- The Home code panel fades into the section under it with a mask, instead of ending on a hard edge.
- GPU page submit uses the router checkout (the path demo:check covers, with cap and refund). The describe box sets its task type and, for GPU-hour tasks, its size.
- Candles on the share view use the api's hourly price history plus every live price the page sees; no bucket is filled in.

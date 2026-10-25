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

- 05:16 integration (early, no conflicts): merged origin/kristian (no new commits), origin/tharun (c09e6d1) and origin/lucy (6584323) into alex. Every changed file belonged to its committer. Typecheck passes in all four workspaces. xrpl tests pass. api 57 of 59 (see Blockers). Restarted demo:prod on the merged code: `/catalog/gpus`, `/catalog/aws`, `/models`, `/gpus/:id/calendar`, `/tasks/estimate`, `/tasks/quote` all answer.
- 05:19 headless pass of every page at 1280 and 400 on the production build: no horizontal scroll, no banned words outside Docs, no em dashes. Fixed: MoneyStack never revealed, GPU page 20 px overflow at 400, hero counted the offline GPU-B, mobile nav had no way to reach the links (added a Menu).
- 05:40 integration: merged origin/tharun (c9c75f3, 7 commits) and origin/lucy (7b09fcb, 10 commits); origin/kristian has nothing new. All files were the committer's own (plus Tharun's new apps/api/tests/rentalCatalog.test.ts). Typecheck clean, xrpl tests pass, api 57 of 59 (same two).
- 05:45 done for teammates: `useTween` now always returns the target's length (Lucy: no NaN frame when points are added, the remount workaround can go). InstantSwitchCard and its Monte Carlo numbers are off /admin/router (Tharun). The browser always calls same-origin `/api` off localhost, even when NEXT_PUBLIC_API_URL is set (Tharun, tunnel sessions).
- 06:20 headless release walk (fresh throwaway devnet wallet made in memory, signed challenge): sign-in, Home, Market, describe and size a task, run a task on Balanced to Complete on GPU-A (69 s), book tomorrow 10 AM (paid, ledger link), buy 1 GPU-A share, Models, Docs, Portfolio, admin, and every page at 400 px with no horizontal scroll. 18 of 22 ok; the four failures are console 404/500s from Kristian's routes (listed under Requests) and GPU-B shown as "Not connected" on Home (fixed: offline GPUs are no longer listed).
- 06:42 integration: merged origin/lucy (265a498, 2 commits, her files only); kristian and tharun had nothing new. Second walk: 21 of 22 ok, including a Balanced task on GPU-A to Complete with "Charged 0.0113 USDC, Refunded 0.0115 USDC", a paid booking for tomorrow 11 AM and a 1-share buy. The one failure was the unfunded throwaway wallet on /borrow; the walk now funds it from the devnet faucet first.
- 06:22 my pages no longer call Kristian's missing routes (`STATS_LIVE` switch); the GPU share view and ticket use `/gpus/:id` and `/shares/*` until then.
- 05:55 an SSE error no longer marks the api unreachable (Quick Tunnels carry no SSE, per docs/VERCEL.md); only a failed fetch does, and the 5 s poll keeps every page fresh.
- 05:30 demo:check dress rehearsal: 8 of 10 steps ok (deposit, escrow, loan, price crash, margin call, liquidation, restore). Collateral and the second loan failed because DEV holds 110 GPU-A shares and the book has too few on offer; demo:reset returns seized collateral to the book and tops DEV up, so the release run starts from that.
- 05:30 Home showcase keeps going after a failed question (it moves to the next one after the pause) instead of stopping.
- 05:22 Home showcase pins `gpuId: "gpu-a"` (Tharun's new option). The task page offers text inference only (the endpoint answers TASK_TYPE_UNAVAILABLE for the others).

- 07:28 release: stopped the stack, `npm run demo:reset` (ok), final integration (origin/lucy status only; kristian, tharun nothing new), typecheck clean in all four workspaces, xrpl tests pass, api 57 of 59 (same two Kristian tests), pricing 26, risk 39, credit 96, router 166 + 1 SAM CLI not installed, compute 37 + 3 failing (Tharun's resume and Monte Carlo tests).
- 07:29 `npm run demo:prod` with a fresh `next build` (compiled, 24 static pages). No activity bot exists in the repo; the market maker runs.
- 07:31 `npm run demo:check`: 12 of 12 ok (deposit, escrow, loan, crash, margin call, crash, liquidation, restore, second loan, early payoff, collateral back, closed).
- 07:34 to 07:50 four headless walks on the production build (fresh testnet-funded wallet each time, signed challenge, 1280 and 400 px): Home, Market, describe and size, book a future hour (paid), buy 1 share, Borrow, Lend, Docs, Portfolio, admin and all nine pages at 400 px pass every time with zero console errors. Run a task on Balanced completed with charge and refund in passes 2 (on the resubmit) and 3 (first try); it failed in pass 1 and both tries in pass 4. Models Try it failed in passes 3 and 4. Every failure is GPU-A's endpoint failing generation (compute returns 503 UPSTREAM_ERROR, router ORDER_FAILED, full refund); 5 direct calls at 07:41 gave 2 successes.
- 07:52 fast-forwarded main to alex and tagged `demo-safe`.

## Next

1. 05:30 checkpoint, 05:40 integration (kristian, tharun, lucy into alex).
2. Wire `GET /gpus/:id/stats` into Home, Market and Portfolio once Kristian's contract lands.
3. Browser check of Home, Market and GPU page at 1280 and 400.
4. Release 07:30 to 08:20: demo:reset, demo:check, demo:prod, browser walk, fast-forward main, tag demo-safe.

## Blockers

- GPU-A generation is intermittent (07:30 onward): about half of all orders fail at 9 to 26 s with compute 503 UPSTREAM_ERROR ("The model endpoint could not start this request"), router ORDER_FAILED, fully refunded. The health check passes. My 06:20 and 06:42 walks (stack started 05:17, before Tharun's 05:40 commits) completed every task; I could not tell from the logs whether the change or the node is the cause. Not touched: compute and router are Tharun's and the Akash lease is off limits.

- api tests 57 of 59, both Kristian's: `GPU nodes cataloged with multi-provider attributes` (expects two READY GPUs; GPU-B is now correctly OFFLINE) and `Credit profile caches responses` (cached read took 140 ms against a 60 ms limit while the full stack was running). Note: `npm test` in apps/api runs 0 tests on Windows because the quoted glob reaches tsx literally; run `npx tsx --test tests/**/*.test.ts` from bash.

- Kristian's contracts (stats, base-apr, market order, market event) were not on origin/kristian at 04:54. The GPU page reads `/gpus/:id/stats` with the shape below and falls back to `/gpus/:id` fields until it answers.
- Tharun's routes (`/catalog/gpus`, `/catalog/aws`, `/models`, `/tasks/*`, `/bookings`, `/gpus/:id/calendar`) are contracts only so far. The UI shows loading or "not available" states until they answer.

## Requests

- Kristian: contract JSON for `GET /gpus/:id/stats`, `GET /lending/base-apr`, `POST /market/:gpuId/order` and the `market` SSE event. The UI already reads this stats shape (all optional, decimals as strings): `{ gpuId, price, change24hPct, volume24h, high24h, low24h, marketCap, holders, navPerShare, yieldPct, paidPerShare24h, bids: [{price, qty}], asks: [{price, qty}], trades: [{t, price, qty, side, hash, explorerUrl}], ticks: [{t, price, qty}], updatedAt }`. Order body: `{ side: "buy" | "sell", qty, price }`, returns the usual TxResult. Emit `market` on every fill or book change.
- Tharun: the router (`/router/quote`, `/router/orders`) still prices from the AWS index, while `/tasks/quote` and the catalog use the GPU market median. The GPU page shows both, so please make the router charge the `/tasks/quote` rate, or make `/tasks/quote` return the router's rate, so the two numbers match.
- Tharun: an option on `POST /v1/chat/completions` to pin `gpu-a` (for the Home showcase). Until then Home shows only answers whose `x_ms.gpus` includes GPU-A.
- Tharun: services/compute/compute/resume.py sends `continue_final_message` on every stream; the Akash node (vLLM 0.6.2) answers 400, so router tasks on GPU-A fail and fall back to GPU-B. Send it only on a resume (partial text) and retry without it on a 400.
- Lucy: the Home borrow card is your BorrowPanel. Please drive its chart from `GET /lending/base-apr` and let it move live (usePolled from `@/lib/liveData` works: `usePolled<T>("/lending/base-apr", { ms: 5000, on: ["loan"] })`).
- Lucy: the charts in `components/charts/` are yours to use (`import { LiveLine, ... } from "@/components/charts"`).

- Kristian: `/lending/markets`, `/lending/dashboard` and `/lending/loanbook` answer 404 on the merged stack, and /lend calls them (console errors on /lend). `/gpus/:id/stats` still 404 (console error on the GPU share view).
- Tharun: about 1 in 3 GPU-A pinned chats (`gpuId: "gpu-a"`) answer 503 ORDER_FAILED after about 11 s; the router log shows ActualCostUsdc 0 for those orders and no reason. Looks like a second order arriving while the single node is busy. Please queue it behind the running order (or return a clear GPU_BUSY) instead of failing. Successful answers take 11 to 21 s end to end.
- Tharun: service suites at 05:55 (pytest with `--basetemp` in a writable folder; the default temp dir is blocked here): pricing 26, risk 39, credit 96 all pass; router 166 pass, 1 fails only because the SAM CLI is not installed (`test_sam_template_validates`); compute 37 pass, 3 fail: `test_monte_carlo_engine_math_and_preemption`, `test_interrupted_at_60_percent_resumes_on_another_gpu_as_one_reply` (state is `done`, expected `interrupted`) and `test_rebalance_checkpoints_without_moving`. The release walk includes a reclaim from /admin/router where the task moves and resumes; with GPU-B offline there is no second GPU to move to. Please say in your status what a reclaim does with one GPU (pause and resume on GPU-A is fine) so the walk can check the right thing.
- Kristian: a signed-in wallet that is not activated on the ledger gets 500 from `/loans/profile/me` and `/loans/max` (credit says ACCOUNT_NOT_FOUND). Please answer a clear 4xx ("Fund this wallet first") instead of a 500. Also 404: `/loans/collateral-options`, `/lending/base-apr`, `/lending/markets`, `/lending/dashboard`, `/lending/loanbook`, `/gpus/:id/stats`, `POST /market/:gpuId/order`.
- Lucy: until Kristian's routes answer, please guard the calls your pages make to them (BorrowPanel on Home calls `/lending/base-apr`; /borrow calls `/gpus/gpu-a/stats` and `/loans/collateral-options`; /lend calls `/lending/*`). Each 404 is a console error in the release walk. My pages gate theirs behind `STATS_LIVE` in `lib/gpuMarket.ts`.
- Lucy: /borrow calls `/loans/profile/me` and `/loans/max` while nobody is signed in and logs two 401s. Please skip those calls until the wallet is connected.
- Kristian: scripts/demo.mjs should start local services on 127.0.0.1, not localhost (Tharun's request, macOS AirPlay on port 5000).

## Decisions

- Home rentals table lists only health-checked GPUs (a GPU that fails its check is not listed at all). "Not connected" is shown for a listed GPU whose compute state is OFFLINE.
- "Working around the clock" keeps its bars from the GPU's own usage history (`/gpus/:id`, last 20 hours and next 4), refreshed every 5 s. The calendar route only covers the future, so it feeds the 7-day booking grid on the GPU page instead.
- The Home code panel fades into the section under it with a mask, instead of ending on a hard edge.
- GPU page submit uses the router checkout (the path demo:check covers, with cap and refund). The describe box sets its task type and, for GPU-hour tasks, its size.
- Candles on the share view use the api's hourly price history plus every live price the page sees; no bucket is filled in.

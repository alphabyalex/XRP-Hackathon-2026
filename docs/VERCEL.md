# Moonshift on Vercel

Frontend: https://moonshift-protocol.vercel.app

Backend: https://hqlndvicrddu7bkcop8kaptoh8.ingress.akash-palmito.org

Project: `tharun-ekambarams-projects/moonshift`. Root directory: `apps/web`.
The backend runs independently on Akash. Its deployment, persistent state and
controlled migration are documented in `infra/akash/backend/README.md`.

## Production configuration

Only the public API origin belongs in Vercel. Never upload the repository's
local `.env`, account database, seeds, Akash management key or Quicknode URLs.

```bash
MOONSHIFT_API_ORIGIN='https://hqlndvicrddu7bkcop8kaptoh8.ingress.akash-palmito.org'
curl --fail "$MOONSHIFT_API_ORIGIN/health"
curl --fail "$MOONSHIFT_API_ORIGIN/catalog/gpus"
vercel env add NEXT_PUBLIC_API_URL production --force --yes --no-sensitive \
  --project moonshift --scope tharun-ekambarams-projects --value "$MOONSHIFT_API_ORIGIN"
vercel env add API_URL production --force --yes --no-sensitive \
  --project moonshift --scope tharun-ekambarams-projects --value "$MOONSHIFT_API_ORIGIN"
```

Both variables name the API root without `/api`. `NEXT_PUBLIC_API_URL` takes
precedence. The setting is used by server requests and Next's external `/api/*`
rewrites. Environment changes require a new deployment.

Deploy a clean checkout of the validated main revision from the repository root:

```bash
vercel deploy --prod --skip-domain --yes --project moonshift --scope tharun-ekambarams-projects
# Inspect the successful build before promoting its returned deployment URL.
vercel promote DEPLOYMENT_URL --yes --scope tharun-ekambarams-projects
```

First check for an existing Git deployment of that exact commit. Do not create a
duplicate while it is building. The production build must pass before promotion.

## Sessions and live updates

Browser requests use the frontend's same-origin `/api/*` proxy. This carries the
existing HttpOnly, SameSite=Lax session cookie, marked Secure for HTTPS. Direct cross-origin browser calls
will not carry the same session in normal browser settings. Server requests use
the configured upstream origin directly.

`/api/events` proxies to `/events`, and `/api/:path*` proxies to `/:path*`.
Pages poll every 2 to 5 seconds and refresh on supported live events. API values
retain their real source timestamps. Missing sources remain empty.

## Release validation

- `/api/health` returns 200 on the frontend origin.
- `/api/catalog/gpus` lists only independently verified healthy workers with actual resources.
- `/api/models` reports the canonical weights actually running on each serving worker.
- A small pinned DEV task on each GPU returns a real answer and validated payment.
- Wallet challenge, sign-in and account reads work through `/api` with cookies.
- Anonymous model prompts return 401; funded authenticated prompts use the actual payer.
- Signed booking ranges show a full-range USDC quote and reject altered or replayed consent.
- Market, lending, Models and Docs load at 1280 and 400 pixels without overflow.
- AWS comparisons retain source timestamps. Bedrock remains explicit opt-in and
  uses deterministic fallback on this backend.

Build in an isolated checkout. Do not share `apps/web/.next` between `next dev`
and a production build.

## Recovery tunnel from Alexander's laptop

Use this only after stopping the Akash writer and restoring its latest state to
the laptop. Never run two backend writers against the same accounts. Use Node 24,
Python 3.11 or later and credentials in the gitignored root `.env`.

Terminal 1, repository root:

```bash
WEB_ORIGIN=https://moonshift-protocol.vercel.app BEDROCK_ENABLED=0 \
  NODE_OPTIONS=--dns-result-order=ipv4first FLEET_SOURCE=own \
  PRICE_SOURCES=aws_public npm run demo
curl --fail http://127.0.0.1:4000/health
```

Terminal 2:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:4000
```

Use the generated `https://...trycloudflare.com` origin in the two Vercel variable
commands above, then deploy the validated web revision. Keep the laptop and
tunnel running. The hostname changes when the tunnel restarts. Quick Tunnels
do not support SSE; the normal 2 to 5 second polling remains necessary.

Sources: [Akash persistent storage](https://akash.network/docs/developers/deployment/akash-sdl/advanced-features/),
[Vercel environment variables](https://vercel.com/docs/environment-variables),
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Caching and observed activity

Public GPU/model reads share short caches and concurrent requests in the browser
and API. Writes and live events invalidate affected public reads. Wallet identity
and balances never enter a public cache; active wallets poll the balance every
five seconds, and prompt admission checks the actual issuer balance again.
Private lending quotes are keyed by wallet, account and all quote inputs.

The share books use funded protocol inventory and cash across five bid and ask
levels. DEV makes bounded real IOC trades on devnet only. Uncertain submissions
halt bot activity until reconciliation. Charts use actual fills, metered work,
ledger observations and validated loan originations. They never backfill invented
history. The borrowing cost curve is explicitly a what-if calculation from the
real APR, selected collateral, principal and term.

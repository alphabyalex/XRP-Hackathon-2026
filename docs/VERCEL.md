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
vercel deploy --prod --yes --project moonshift --scope tharun-ekambarams-projects
```

First check for an existing Git deployment of that exact commit. Do not create a
duplicate while it is building. The production build must pass before promotion.

## Sessions and live updates

Browser requests use the frontend's same-origin `/api/*` proxy. This carries the
existing HttpOnly, SameSite=Lax session cookie. Direct cross-origin browser calls
will not carry the same session in normal browser settings. Server requests use
the configured upstream origin directly.

`/api/events` proxies to `/events`, and `/api/:path*` proxies to `/:path*`.
Pages poll every 2 to 5 seconds and refresh on supported live events. API values
retain their real source timestamps. Missing sources remain empty.

## Release validation

- `/api/health` returns 200 on the frontend origin.
- `/api/catalog/gpus` lists the health-checked T4 and V100 with actual resources.
- `/api/models` identifies Qwen2.5-1.5B on GPU-A and Qwen2.5-3B on GPU-B.
- A small pinned DEV task on each GPU returns a real answer and validated payment.
- Wallet challenge, sign-in and account reads work through `/api` with cookies.
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

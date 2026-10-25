# Moonshift on Vercel

Production: https://moonshift-protocol.vercel.app

Project: `tharun-ekambarams-projects/moonshift`. Root directory: `apps/web`.
Production traffic was resumed in the dashboard on 2026-10-25. No deployment
was created during the night run. The existing deployment remains an older build
until Alex releases the integrated head in the morning.

## Morning: Alexander's laptop

Use Node 24 and Python 3.11 or later. Keep credentials only in the local,
gitignored root `.env`. Never put keys in Vercel public variables.

Terminal 1, from the repository root:

```bash
git fetch origin
git switch alex
git pull --ff-only origin alex
npm ci
WEB_ORIGIN=https://moonshift-protocol.vercel.app BEDROCK_ENABLED=1 \
  FLEET_SOURCE=own PRICE_SOURCES=aws_public npm run demo
```

The script starts services and selects port 5001 if macOS owns port 5000.
Do not start a second stack. Verify the API before opening its tunnel:

```bash
curl --fail http://127.0.0.1:4000/health
curl --fail http://127.0.0.1:4000/catalog/gpus
curl --fail 'http://127.0.0.1:4000/models?gpuId=gpu-a'
```

Terminal 2:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:4000
```

Leave this terminal open. Copy only the generated public
`https://...trycloudflare.com` origin below. It is an API URL, not a Quicknode
endpoint. Its hostname changes whenever the tunnel restarts.

Terminal 3, from the repository root:

```bash
MOONSHIFT_API_ORIGIN='https://replace-with-current-host.trycloudflare.com'
curl --fail "$MOONSHIFT_API_ORIGIN/health"
curl --fail "$MOONSHIFT_API_ORIGIN/catalog/gpus"
vercel env add NEXT_PUBLIC_API_URL production --force --yes --no-sensitive \
  --project moonshift --scope tharun-ekambarams-projects --value "$MOONSHIFT_API_ORIGIN"
vercel env add API_URL production --force --yes --no-sensitive \
  --project moonshift --scope tharun-ekambarams-projects --value "$MOONSHIFT_API_ORIGIN"
```

`NEXT_PUBLIC_API_URL` is the canonical upstream for server fetches and Next's
`/api/*` rewrites. `API_URL` is only a legacy fallback. Both values above name
the API root, without `/api` at the end. The public variable takes precedence.
Environment changes require a subsequent deployment; they do not update a running
build. Alex owns the morning release. Do not redeploy during the night run.

## Browser sessions and live updates

Browser requests must use the web origin's `/api/*` proxy. This keeps the existing
HttpOnly, SameSite=Lax session cookie on the Vercel origin. Direct browser calls
to the tunnel origin will not carry this session in normal browser settings.
Server requests use `NEXT_PUBLIC_API_URL` to reach the upstream directly.

The shared web API client must apply this rule to the router, lending and live
data clients. Alex owns this change. Next rewrites `/api/events` to `/events`
and `/api/:path*` to `/:path*`.

Cloudflare Quick Tunnels do not support SSE. Poll reads every 2 to 5 seconds over
this morning tunnel. `/catalog/aws` returns the same timestamped snapshot as the
`aws` SSE event. Quotes use cached rates. For a stable URL and SSE use an existing
named tunnel or another streaming-capable host. Quick Tunnels have no uptime
guarantee and stop when their process exits.

## Release validation

- `/api/health` answers on the production web origin.
- Catalog lists only health-checked endpoints and Qwen2.5-1.5B-Instruct on GPU-A.
- Connect a wallet and verify account reads through `/api`, then run a small task.
- On Alexander's laptop verify `/tasks/estimate` reports `source: "bedrock"` with
  his configured Haiku model. Without opt-in and credentials it reports `fallback`.
- AWS values include real source timestamps. Missing sources remain empty.
- Keep the laptop stack and tunnel running for the presentation.

Do not run `vercel build` against `apps/web/.next` while `next dev` uses that same
directory. The previous session's chunk-loader crash came from sharing this
build directory. Stop dev first or build in an isolated checkout.

Sources: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
[Vercel environment variables](https://vercel.com/docs/environment-variables),
[Vercel project resume](https://vercel.com/docs/projects/managing-projects#resuming-a-project).

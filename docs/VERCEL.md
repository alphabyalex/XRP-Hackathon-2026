# Deploying Moonshift Web to Vercel

This guide outlines how to deploy the Moonshift web frontend (`apps/web`) to Vercel.

---

## 1. Vercel Dashboard Setup

When importing the repository in the [Vercel Dashboard](https://vercel.com/new):

1. **Select Repository**: `XRP-Hackathon-2026`
2. **Framework Preset**: `Next.js` (automatically detected)
3. **Root Directory**: Click "Edit" and choose `apps/web`
4. **Build & Output Settings**:
   - Build Command: `next build` (default)
   - Output Directory: `Next.js default` (default)
   - Install Command: `npm install` (default)

---

## 2. Environment Variables

Configure the following environment variables in the Vercel project settings:

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_API_URL` | Recommended | URL of the running Moonshift API server | `https://api.yourdomain.com` |
| `API_URL` | Optional | Fallback server-side backend target for Next.js rewrites | `http://your-server-ip:4000` |
| `NEXT_PUBLIC_DEBUG_TIMING` | Optional | Enable millisecond logging for client API requests | `0` or `1` |

> [!NOTE]
> If `NEXT_PUBLIC_API_URL` is not provided in production, the web application automatically routes requests to `${origin}/api`, which Next.js rewrites to the backend URL specified in `API_URL` (defaulting to the local API port in development).

---

## 3. Deploying via Vercel CLI

To build or deploy directly using the Vercel CLI:

```bash
# 1. Navigate to the web app
cd apps/web

# 2. Simulate local production build
vercel build

# 3. Deploy preview
vercel deploy

# 4. Deploy production
vercel deploy --prod
```

---

## 4. Architecture & CORS

- `apps/web` runs as a high-performance Next.js 15 application on Vercel Edge / Serverless.
- Cross-origin credentials (`credentials: "include"`) ensure the wallet session cookie is sent with requests.
- When configuring `apps/api`, ensure `WEB_ORIGIN` matches your Vercel deployment domain (e.g., `https://your-app.vercel.app`) to allow authenticated sessions.

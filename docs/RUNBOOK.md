# Runbook

How to run Moonshift locally. Lending (XLS-65 vaults, XLS-66 loans) runs on XRPL **devnet**. Nothing here ever touches mainnet.

## 1. Install

```
cd moonshift
npm install
```

Python services (pricing, risk, credit, compute) need **Python 3.11 or newer**. Each one gets its own virtual environment, because their pinned FastAPI and pydantic versions differ. `npm run demo` creates and fills the venvs automatically (`services/<name>/.venv`). By hand:

```
cd services/risk
py -3.12 -m venv .venv            # macOS/Linux: python3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 7000
```

| Service | Folder | App | Port | Owner |
|---|---|---|---|---|
| web | apps/web | Next.js | 3000 | Alex |
| api | apps/api | Express | 4000 | Alex |
| compute | services/compute | `compute.main:app` | 5000 | Tharun (EC2) |
| pricing + Bedrock memo | services/pricing | `app.main:app` | 6000 | Tharun |
| risk desk + keeper | services/risk | `app.main:app` | 7000 | Kristian |
| credit (Quicknode) | services/credit | `credit.main:app` | 7100 | Lucy |

## 2. Configure

```
cp .env.example .env
```

- `INTERNAL_API_KEY`: one shared value. **Every** service must see the same key; it goes in the `X-MS-Internal-Key` header on every service-to-service call. `npm run demo` passes the root `.env` to every process. If the key is unset there, it uses a local-only default.
- `ADMIN_KEY` for `/admin/*`.
- `NETWORK=devnet` for lending. Devnet seeds (`DEVNET_<NAME>_SEED`) are written by setup, never by hand, and are never printed.
- `QUICKNODE_WSS` is testnet only (Quicknode has no devnet) and is never printed.

## 3. Build the devnet world (once, and after any devnet reset)

```
npm run demo:reset
```

This runs setupNetwork on devnet and is safe to rerun:
- Faucet top-ups.
- Issuers and flags, TDX, GPU shares, compute tokens, DEX offers, oracles.
- Lending rounds: one vault round lending, the next one open for deposits.

It then closes leftover loans, restores the oracle prices, makes sure ALICE holds GPU shares, and clears the api's loan tables.

## 4. Run everything

```
npm run demo          # web + api on devnet + pricing/risk/credit if Python 3.11+ exists
npm run demo:mock     # same, but an in-memory ledger (no network)
npm run dev           # web + api only, mock flags from .env
```

- Without Python 3.11+, the api uses its **built-in mocks** for pricing, risk and credit. They return exactly the `contracts/` shapes, labeled simulated.
- If a real service dies mid-demo, the api falls back to the mock (source `mock-fallback`) and keeps going.
- `GET /health/services` shows which source answered.

Pages:
- `/` landing.
- `/market` GPUs.
- `/gpu/gpu-a` schedule and trading.
- `/borrow` credit profile, quote, memo, open loan, loan health, stress.
- `/lend` vault rounds, deposit and withdraw, loan book, stress test.
- `/portfolio`.
- `/playground` the code sample and live Try It box.

Check the whole demo path from the command line (needs `npm run demo` running):

```
npm run demo:check    # deposit, quote, open, margin call, liquidation, restore, repay; prints a tx table
```

## 5. Tests

```
npm run typecheck           # web, api, shared, xrpl
npm run test:xrpl           # xrpl unit tests (no network)
NETWORK=devnet npm run xrpl:smoke   # on-ledger smoke + full lending cycle on devnet
cd services/<name> && .venv\Scripts\python -m pytest
```

## 6. Mock switches (api)

| Switch | 1 (default) | 0 |
|---|---|---|
| `MOCK_XRPL` | in-memory ledger | packages/xrpl on `NETWORK` (devnet for lending) |
| `MOCK_COMPUTE` | simulated GPU calendar and revenue | services/compute at `COMPUTE_URL` |
| `MOCK_PRICING` | fallback memo, placeholder prices | services/pricing at `PRICING_URL` (Bedrock) |
| `MOCK_RISK` | TypeScript port of the risk quote, api keeper | services/risk at `RISK_URL` |
| `MOCK_CREDIT` | deterministic simulated profile | services/credit at `CREDIT_URL` |

`npm run demo` sets `NETWORK=devnet MOCK_XRPL=0` and turns each Python service's flag to 0 when it starts.

## 7. Fallbacks during a live demo

- **A Python service crashes:** nothing to do. The api falls back to its mock and labels it.
- **Devnet was reset, or "no vault round is lending":** run `npm run demo:reset` (2 to 3 minutes).
- **A loan is stuck in margin call:** press "Restore price" on /borrow or /lend, or pay it off.
- **Full reset of api state:** `POST /admin/demo/reset` (requires `ADMIN_KEY`), or `npm run demo:reset`.

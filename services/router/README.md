# services/router

Owner: Lucy. Python 3.12, FastAPI, port 7200. The Moonshift order router:
customers pick Cheapest, Balanced or Fastest, and the router places the order
on the best GPU(s) across every provider it can see, settles on XRPL devnet,
and resumes interrupted work on another GPU instead of restarting.

Design: docs/ROUTER.md. Price sources: docs/ROUTER_PROVIDERS.md.
Contracts: contracts/router/*.json.

## Run

```
cd services/router
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt   # runtime only: requirements.txt
uvicorn router.main:app --port 7200
```

The default fleet contains the existing Akash Network T4 running Qwen2.5-1.5B-Instruct.
Public AWS prices are comparisons. They do not imply that Moonshift owns EC2 GPU capacity.
Own-fleet rental and task rates use the same live GPU Economy median exposed by
the API's independent `/gpu-prices` cache. The router reads that snapshot every
15 seconds in the background. Quote requests use memory and make no price-feed
network calls. Missing or stale medians disable pricing without an AWS or static
fallback. All modes use the same hourly rate and duration on one physical GPU.
Only a passing endpoint health check and live median allow task admission.
Development fixtures are available only when `FLEET_SOURCE=mock` is explicitly selected.

## Switches

| Env var | Default | Meaning |
|---|---|---|
| `FLEET_SOURCE` | `own` | `own` and `live` configure only GPU-A. `mock` explicitly enables the development fleet. |
| `PRICE_SOURCES` | `aws_public` | `aws_public` reads AWS's public spot and on-demand feeds without credentials. `all` or explicit provider collectors enable their real APIs. Non-mock fleets never use fixture prices. |
| `STATE_BACKEND` | `local` | `local` (SQLite) or `dynamodb` |
| `QUEUE_BACKEND` | `local` | `local` or `sqs` |
| `ORCHESTRATOR` | `local` | `local` or `stepfunctions` |
| `SETTLEMENT` | `api` | `api` (devnet through apps/api) or `off` |
| `LEDGER_SIGNER` | `router` | `router`: services/router signs its own XRPL transactions (cap locked in an EscrowCreate, settled by one all-or-nothing Batch: EscrowFinish + MS_SETTLE to each GPU treasury and provider account + MS_REFUND). `api`: the older plain Payments through apps/api `/internal/router/pay` |
| `NETWORK` | `devnet` | `devnet` or `testnet` for the router's own transactions; mainnet is refused. Seeds are read from the repo `.env` (`DEVNET_<NAME>_SEED` / `<NAME>_SEED`) |
| `LEDGER_BATCH` | `1` | `0` settles one transaction at a time instead of in a Batch |
| `ESCROW_MIN_SECONDS` | `7200` | Minimum time before the buyer can cancel the escrow and take the whole cap back |
| `AWS_REGION` | `us-east-2` | Price List calls always go to us-east-1 |
| `AWS_DEPLOY`, `AWS_LAUNCH`, `EXTERNAL_LAUNCH` | `0` | anything billable stays off unless a human sets these |
| `CLOUDWATCH`, `BEDROCK_EXPLAIN` | `0` | metrics and the "why" text |

AWS credentials come only from the default chain (`AWS_PROFILE` locally, an
IAM role on EC2). Provider API keys come from Secrets Manager
(`moonshift/router/providers`). Neither is ever logged.

## Test

```
pytest
mypy
ruff check .
```

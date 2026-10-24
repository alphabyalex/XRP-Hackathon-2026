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
pip install -r requirements.txt
uvicorn router.main:app --port 7200
```

Everything is local and mock by default (no cloud account needed).

## Switches

| Env var | Default | Meaning |
|---|---|---|
| `FLEET_SOURCE` | `mock` | `mock` = config/fleet.json, `live` = config/fleet.live.json |
| `PRICE_SOURCES` | `none` | collectors that call real APIs: `all`, `none`, or a comma list (`azure_retail,oracle,runpod,vast,aws_spot_advisor,aws_pricing,aws_spot_price,aws_placement,aws_offerings,aws_capacity_blocks,gcp_catalog,lambda`) |
| `STATE_BACKEND` | `local` | `local` (SQLite) or `dynamodb` |
| `QUEUE_BACKEND` | `local` | `local` or `sqs` |
| `ORCHESTRATOR` | `local` | `local` or `stepfunctions` |
| `SETTLEMENT` | `api` | `api` (devnet through apps/api) or `off` |
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

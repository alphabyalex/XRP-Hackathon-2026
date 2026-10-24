# Moonshift order router

Owner: Lucy. Service: `services/router` (Python 3.12, FastAPI, port 7200).
Price sources: [ROUTER_PROVIDERS.md](ROUTER_PROVIDERS.md). Contracts: `contracts/router/`.

A customer renting GPU compute picks **Cheapest**, **Balanced** or **Fastest**.
The router prices every GPU it can see (Moonshift's own GPUs, AWS, Microsoft
Azure, Google Cloud, Oracle and GPU marketplaces), places the order on the best
one to three GPUs for that goal, settles on XRPL devnet, and when a GPU is taken
away mid-job, resumes the work on another GPU instead of restarting it. AWS is
the control plane.

## How one order flows

```
checkout (apps/web)  ->  apps/api /router/*  ->  router  POST /quote   three plans from the latest catalog
                                                         POST /orders  optimize, lease GPU slots, pay
 MS_ORDER  buyer -> order treasury (devnet)
 dispatch  tier queue (fastest > balanced > cheapest)  ->  worker runs the parts
 reclaim?  checkpoint, re-plan the rest in the same mode, continue on another GPU (any provider)
 settle    MS_SETTLE per GPU for work it served, MS_REFUND of the rest (devnet)
 events    quoted, paid, running, token, progress, moved, completed, settled (SSE)
```

## The model

An order is a job size (tokens for inference, GPU-minutes for rented time), an
optional deadline, an optional budget, optional constraints (GPU model, region,
providers to exclude) and a mode. Candidates are fleet entries that are
executable (an account and a worker), available (not reclaimed, offline or out
of capacity) and fresh (price younger than `CATALOG_MAX_AGE`, or a degraded last
good snapshot up to 4x that). The optimizer never chooses an offer it cannot run.

For a part of the order on GPU g with work w:

| Quantity | Formula |
|---|---|
| run time | w / tokensPerSec (inference) or w minutes (rental) |
| start | first time at or after the queue wait when startup + run + guard clears every booked window on g |
| interruption probability | p = 1 - exp(-rate x run hours), rate from the catalog (AWS: Spot Advisor band blended with the placement score; others: provider default or marketplace reliability; on-demand, reserved and Moonshift: 0) |
| resume cost | resume latency (new worker start + re-reading prompt and partial answer) + lost progress since the last checkpoint (0 when the warning window covers a flush, else half a checkpoint interval). Never zero. |
| egress | checkpoint size x g's egress price, only when the likely resume target is another provider |
| expected cost | price x run + p x (price x resume time + egress) |
| expected completion | start + startup + run + p x resume time |

A plan is up to 3 parts (a single streamed reply is never split; batches of
prompts and rented time can be). Plan cost is the sum, completion the maximum,
risk 1 - product of (1 - p). Every split on a 12-step share grid over every
combination of up to 3 candidates is evaluated (hundreds of plans, milliseconds).

## The three objectives

- **Cheapest:** minimum expected cost subject to deadline and budget.
- **Fastest:** minimum expected completion subject to budget (and the deadline,
  whenever any plan meets it).
- **Balanced:** the knee of the cost/time trade. Build the Pareto frontier of
  feasible plans (sorted by completion, keep each plan strictly cheaper than
  every faster one), min-max normalize cost and time over the frontier, and pick
  the plan closest to the ideal corner (0, 0) by Euclidean distance. Ties break
  by cost, then time, then GPU ids, so the result is deterministic.

Because all three choose from the same feasible set, Cheapest never costs more
than Fastest, Fastest never finishes later than Cheapest, and Balanced lies
between on both (tested over random orders). `/quote` returns all three plus
`alternativesConsidered` (offers per provider), `plansEvaluated` and
`catalogAsOf`. With `BEDROCK_EXPLAIN=1`, Amazon Bedrock writes a short "why"
from the plans' numbers; any sentence with a number that is not in the input is
dropped (shown only on /admin/router).

## Prices and availability across providers

Collectors (one per provider, `services/router/router/collectors/`) are plain
functions, so the same code runs in the router or as a Lambda. Verified sources
and their interruption warnings are in [ROUTER_PROVIDERS.md](ROUTER_PROVIDERS.md):
AWS Price List, Spot price history, Spot placement scores, instance type and
Capacity Block offerings, and the Spot Instance Advisor; the Azure Retail Prices
API; the Google Cloud Billing Catalog; Oracle's price list; Lambda, RunPod and
Vast.ai live availability; and a static CoreWeave table. External capacity is
resold at its price x (1 + 15% margin); Moonshift GPUs use their own price.

## AWS architecture

```
EventBridge Scheduler --5 min--> Collector Lambda (spot) ------+
                      --15 min-> Collector Lambda (providers) -+--> DynamoDB ms-router-catalog (latest offer)
                      --daily--> Collector Lambda (on-demand) -+--> S3 ms-router-prices/<provider>/<date>/ (history)
                                     reads keys from Secrets Manager moonshift/router/providers

router (FastAPI) --POST /orders--> DynamoDB ms-router-orders (order + per-GPU slot leases, conditional writes)
                 --start--------> Step Functions ms-router-order (Pay -> Dispatch -> Settle, pointers only)
                                     Dispatch: SQS ms-router-{fastest,balanced,cheapest} with a task token
workers (any provider) --long poll--> tier queues, extend visibility, heartbeat, SendTaskSuccess
                       --checkpoints--> DynamoDB ms-router-checkpoints (TTL 24 h; over 350 KB to S3)
   EC2: instance profile ms-router-worker   others: IAM Roles Anywhere (X.509) or an SSM hybrid activation

EC2 events (Spot Interruption Warning, Rebalance Recommendation, Capacity Block Expiration Warning,
Capacity Reservation Instance Interruption Warning) --EventBridge rule--> SQS ms-router-aws-events
   --> router POST /internal/aws-events (or the forwarder Lambda) --> reclaim(gpuId, warning, reason)

CloudWatch: Moonshift/Router metrics, worker GPU metrics (agent), logs
Cost: moonshift:orderId tags on launched resources, CUR 2.0 joined to orders in Athena
```

All of it is in `services/router/infra/template.yaml` (AWS SAM, validated by
cfn-lint in the tests) with least-privilege roles. Nothing is deployed unless
`AWS_DEPLOY=1`, and nothing billable is launched unless `AWS_LAUNCH=1` /
`EXTERNAL_LAUNCH=1`. Every AWS dependency has a local mode, so the demo runs
offline: `FLEET_SOURCE=mock|live`, `STATE_BACKEND=local|dynamodb`,
`QUEUE_BACKEND=local|sqs`, `ORCHESTRATOR=local|stepfunctions`, `PRICE_SOURCES`.

**Workers outside AWS.** A worker on another cloud or a Moonshift machine gets
temporary AWS credentials either through **IAM Roles Anywhere** (an X.509
certificate from our CA, trust anchor and profile in the template, role
`ms-router-worker`) or, for Moonshift's own machines, an **AWS Systems Manager
hybrid activation** (registers the machine as a managed node with the same
role). Creating the CA certificate or the activation needs a human (Blockers).

## Resume, don't restart

Inspired by SpotServe (Miao et al., "SpotServe: Serving Generative Large Language
Models on Preemptible Instances", ASPLOS 2024, arXiv:2311.15566): cheap
interruptible GPUs versus pricier guaranteed ones is a real cost/latency trade;
work on interruptible capacity should resume from saved progress, not restart;
and the provider's warning window is the time to checkpoint and move. We apply
those ideas to a small single-GPU model, not SpotServe's multi-GPU parallelism.

- **Checkpoints.** Inference progress is saved at the token level: the prompt
  plus the tokens generated so far, every 16 tokens and at the signal.
- **Triggers, one function.** `reclaim(gpuId, warningSeconds, reason)` is called
  by: a booking about to start on the GPU (compute's drain window, also checked
  by the router), `POST /fleet/{id}/reclaim` (manual, /admin/router), EventBridge
  EC2 events (a Rebalance Recommendation only checkpoints, it does not move), and
  workers that see a provider notice themselves (EC2 IMDS spot/instance-action
  polled every 5 s, Azure Scheduled Events Preempt, GCP preempted metadata).
- **Move.** Stop admitting on that GPU, checkpoint, ask the optimizer for the
  best other GPU (any provider) for the remaining work in the order's own mode
  and constraints, then continue: the new GPU receives the original prompt plus
  the partial answer and continues the same assistant message
  (`continue_final_message` on vLLM), so the client's stream has no break.
- **Accounting.** Each segment records the work it served; settlement and usage
  pay each GPU only for that, so no token is billed twice. `restarts` is 0.
- **Where the code lives.** `services/compute/compute/resume.py` (token stream,
  checkpoints, interrupt, notice pollers) with two small hooks in Tharun's files;
  the router's side is `router/orders.py`, `router/engine.py` and
  `router/aws_events.py`.

## Settlement on devnet

All TDX (shown as USDC), through apps/api `POST /internal/router/pay`, which signs
with the packages/xrpl wallets:

1. `MS_ORDER {orderId, mode}`: buyer -> order treasury (PROTOCOL_FEES), the quote.
2. `MS_SETTLE {orderId, gpuId, tokensOrMinutes}`: order treasury -> TREASURY_GPU_A
   or TREASURY_GPU_B for the work each GPU served. For external capacity the
   pool receives Moonshift's margin; the provider's cost stays in the order
   treasury, which also serves as the external-capacity treasury.
3. `MS_REFUND {orderId}`: order treasury -> buyer, whatever was not used.

The buyer never pays more than the quote.

## Observability and cost truth

**Metrics and logs.** Every quote, order, move and settlement writes one JSON
log line (logger `router.metrics`). With `CLOUDWATCH=1` the same numbers go to
Amazon CloudWatch, namespace `Moonshift/Router`:

| Metric | Unit | Dimensions | Meaning |
|---|---|---|---|
| Quotes, PlansEvaluated | Count | | how much of the market each quote looked at |
| Orders, PredictedCostUsdc | Count, None | Mode | orders per mode and what we quoted |
| Moves, ResumeLatency | Count, Seconds | Reason | every resume, and how long the handoff took |
| ActualCostUsdc, CostErrorPct | None, Percent | Mode | served work at each GPU's price vs the quote |

Workers on EC2 run the CloudWatch agent with `services/router/infra/cloudwatch-agent.json`
(nvidia_gpu utilization, memory, temperature and power, plus worker logs to
`/moonshift/router/workers`), namespace `Moonshift/Workers`.

**Cost tags.** Anything the router launches for an order (`router/launch.py`,
only with `AWS_LAUNCH=1`) is tagged `moonshift:orderId=<orderId>` and
`moonshift:component=router-worker`, on the instance and its volumes. Shared
resources (tables, queues, the state machine) carry `moonshift:component=router`.

**Joining the AWS bill to orders (CUR 2.0).** A human sets this up once
(Blockers in docs/status/lucy.md):
1. Billing console, Cost allocation tags: activate the user tag `moonshift:orderId`.
2. Billing console, Data Exports: create a standard CUR 2.0 export with resource
   IDs and hourly granularity, to S3, Parquet, with an Athena integration.
3. Export orders to the same Glue database: the `ms-router-orders` table
   (DynamoDB export to S3, or the router's `GET /orders`).
4. Compare predicted and actual per order:

```sql
SELECT o.orderId, o.mode, o.priceUsdc AS predicted_usdc,
       SUM(c.line_item_unblended_cost) AS aws_actual_usd
FROM cur2 c
JOIN router_orders o ON c.resource_tags['user_moonshift_order_id'] = o.orderId
WHERE c.line_item_line_item_type = 'Usage'
GROUP BY o.orderId, o.mode, o.priceUsdc
ORDER BY aws_actual_usd DESC;
```

CUR 2.0 lags by hours, so `CostErrorPct` in CloudWatch is the live signal
(served work at catalog prices vs the quote) and CUR is the end-of-day truth.

**Container images.** `services/router/Dockerfile` builds the router (also used
by workers outside Lambda). Push to Amazon ECR only with `AWS_DEPLOY=1`:

```
aws ecr create-repository --repository-name ms-router --region us-east-2
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-2.amazonaws.com
docker build -t ms-router services/router
docker tag ms-router <account>.dkr.ecr.us-east-2.amazonaws.com/ms-router:latest
docker push <account>.dkr.ecr.us-east-2.amazonaws.com/ms-router:latest
```

## Benchmark

<!-- benchmark:start -->
Simulation, 1000 synthetic orders (60% inference, 40% rentals of 5 to 60 minutes, half with a deadline of 4x their single-T4 run time, Poisson arrivals every 150 s on average), seed 7, mock catalog (fixtures), 6 GPUs, run 2026-10-24 18:45. Reproduce: `python services/router/scripts/benchmark.py`.

**catalog interruption rates**

| Policy | Total cost (USDC) | p50 completion | p99 completion | Interruptions | Resumed (moves) | Restarts | Work share by provider |
|---|---|---|---|---|---|---|---|
| cheapest | 30.7383 | 60.4 s | 23006.2 s | 1 | 1 | 0 | azure 57.0%, aws 36.6%, moonshift 3.9%, vast 2.5% |
| balanced | 35.9752 | 48.9 s | 1801.0 s | 0 | 0 | 0 | moonshift 35.7%, aws 30.6%, azure 29.7%, vast 4.0% |
| fastest | 73.6474 | 48.5 s | 1367.7 s | 0 | 0 | 0 | moonshift 48.9%, aws 34.7%, azure 10.1%, vast 6.3% |
| aws_only | 99.0087 | 2865.6 s | 18417.5 s | 0 | 0 | 0 | aws 100.0% |
| round_robin | 73.1340 | 301.0 s | 5699.2 s | 0 | 0 | 0 | aws 34.8%, moonshift 33.4%, vast 16.6%, azure 15.3% |

**stress: every rate x 500**

| Policy | Total cost (USDC) | p50 completion | p99 completion | Interruptions | Resumed (moves) | Restarts | Work share by provider |
|---|---|---|---|---|---|---|---|
| cheapest | 31.5449 | 60.4 s | 20922.5 s | 21 | 21 | 0 | azure 56.1%, aws 28.0%, moonshift 13.3%, vast 2.5% |
| balanced | 36.2114 | 48.9 s | 1801.0 s | 12 | 12 | 0 | moonshift 35.5%, aws 30.6%, azure 29.5%, vast 4.4% |
| fastest | 73.7524 | 48.5 s | 1367.7 s | 6 | 6 | 0 | moonshift 48.9%, aws 34.6%, azure 10.0%, vast 6.4% |
| aws_only | 95.9272 | 2854.2 s | 11974.4 s | 6 | 6 | 0 | aws 100.0% |
| round_robin | 73.7349 | 302.0 s | 5738.6 s | 10 | 0 | 10 | aws 37.9%, moonshift 32.9%, vast 16.3%, azure 12.9% |
<!-- benchmark:end -->

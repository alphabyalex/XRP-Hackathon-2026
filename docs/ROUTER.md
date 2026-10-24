# Moonshift order router

Owner: Lucy. Service: `services/router` (port 7200). Price sources:
[ROUTER_PROVIDERS.md](ROUTER_PROVIDERS.md). Contracts: `contracts/router/`.

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

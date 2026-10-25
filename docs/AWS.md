# AWS: Bedrock and live GPU price comparisons

Moonshift uses Amazon Bedrock for task sizing and credit explanations. A live,
read-only AWS price feed supplies spot and on-demand comparisons. Compute runs
on the existing Akash NVIDIA T4, not on AWS.

EC2 GPU quota was denied; no EC2 GPU instance is deployed.

## Bedrock

The pricing service reads `BEDROCK_MODEL_ID`; the default is
`us.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5).
Use the account's accessible Haiku inference profile in this variable rather
than assuming an alternative profile is available. Region: `us-east-2`.

Bedrock is explicitly opt-in: `BEDROCK_ENABLED=1` plus valid local AWS
credentials are required. On Tharun's laptop the flag stays off and every
Bedrock route uses deterministic fallback. Tests inject model responses and
never call AWS. Alex verifies real calls on his machine during integration.

`POST /tasks/estimate` accepts a description and type: inference, fine-tune,
render or other. The service asks Haiku only for resource sizes and duration.
Strict validation allows 1 to 8 GPUs, 1 to 128 vCPU, 1 to 1024 GB RAM,
1 to 10000 GB storage and 60 to 604800 seconds. Integers must actually be
integers. Inference can name only the deployed Qwen2.5-1.5B-Instruct; other
task types cannot select a model. Extra fields and model-invented prices
are rejected. Invalid JSON, invalid sizes, unavailable credentials and timeouts
all return the deterministic estimator with `source: "fallback"`.

The API filters suggested GPUs against healthy hardware. Training and rendering
are not executable on the current text endpoint and report unsupported. An
estimate is sizing guidance, not a completion guarantee. Prices are computed
separately from cached live rates and disclosed formulas. Haiku cannot set them.

The task-sizing call has a maximum 12-second budget, a 2-second connection
timeout, a 10-second read timeout and no SDK retries. Responses expose
`latencyMs`, `region`, `source` and the model identifier used. Real Bedrock latency
has not been measured on this laptop.

Existing credit memos and risk explanations use a number guard: the accepted
numbers come only from the supplied ledger/profile/quote facts and their
formatted equivalents. Unsupported numerical claims are removed or trigger
bounded retry and deterministic fallback. No secrets or full prompts are logged.

## Price feed and rental formula

GPU Economy supplies a card's observed median USD per GPU-hour. The rental
catalog uses this live median directly. Missing or stale rates are unavailable,
not replaced by hardcoded sample prices. Resource sliders must fit the actual
node; without separately published component prices, the whole node rate is
charged and unpublished CPU/RAM/storage unit rates remain null.

AWS spot and on-demand rates are separate provider comparisons. They are not
claims that an AWS GPU is deployed or rented by this application. All values
carry their original source timestamp and source URL. The router's live AWS
collector uses official public price feeds without launching an instance.
Authenticated AWS collection, when configured, is read-only: Pricing GetProducts
and EC2 DescribeSpotPriceHistory. No deployment or instance launch is performed.

Router collection refreshes spot rates every 300 seconds and on-demand rates
every 86400 seconds. The API polls the router snapshot every 5 seconds, preserves
upstream timestamps and emits SSE event `aws` only when that snapshot changes.
`GET /catalog/aws` exposes the same snapshot for polling. A missing source
returns empty arrays and null timestamps. Consumers can show elapsed age from
`updatedAt`; they must not turn the retrieval time into a fresh source time.

`GET /catalog/gpus` compares the GPU Economy median with AWS spot and on-demand.
The 24-hour change is null until observations span the required period.
Utilization history appends only actually observed worker-busy samples; it does
not backfill an invented day. Free and busy node counts come from health and
real router leases, not marketplace stock counts.

`POST /tasks/quote` calculates price per hour, total price and a cap from the
cached catalog. The request makes no upstream price call, so slider requests
stay fast. Cheapest, Balanced and Fastest retain the requested duration when
there is no measured performance evidence for different speeds. One online
physical node cannot promise multiple simultaneously available GPUs.

## Morning verification

On Alexander's machine, after the local stack is running with opt-in enabled:

```bash
curl --fail --json '{"description":"Summarize a short article","type":"inference"}' \
  http://127.0.0.1:4000/tasks/estimate
curl --fail http://127.0.0.1:4000/catalog/aws
curl --fail http://127.0.0.1:4000/catalog/gpus
```

Check `source: "bedrock"` and a real latency for the first response. If it says
fallback, inspect IAM/model access on Alex's machine without printing keys.
Verify source timestamps on both AWS price classes. Run a small task and verify
its settlement separately. Follow docs/VERCEL.md for the API tunnel and web release.

No billable AWS infrastructure, Akash lease mutation or Vercel redeployment is
part of the night run.

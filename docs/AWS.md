# AWS: Bedrock and live GPU price comparisons

Moonshift uses Amazon Bedrock for task sizing and credit explanations. A live,
read-only AWS price feed supplies spot and on-demand comparisons. Compute runs on independently verified Akash GPU leases. Actual hardware, model,
lease costs and measurements are recorded under `infra/akash/leases` and
`contracts/compute`; unverified workers stay unavailable.

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
integers. Inference must use a model actually served by the selected healthy worker;
other task types cannot select a model. Extra fields and model-invented prices
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

The rental price uses each GPU's verified Akash lease cost plus the configured
margin (25% by default). The accepted bids were verified through the Akash CLI:
GPU-A is 272 uact/block and GPU-B is 383.910083 uact/block. At 600 blocks/hour,
these are $0.1632/hour and $0.2303460498/hour before margin. The conversion is an
estimate based on block cadence, not a fixed fiat charge per wall-clock hour.
Each policy includes its verification timestamp. GPU Economy supplies a
separate observed median comparison; losing that comparison does not invalidate
a configured lease price. Missing lease prices remain unavailable.
Resource sliders must fit the actual
node; without separately published component prices, the whole node rate is
charged and unpublished CPU/RAM/storage unit rates remain null.

AWS spot and on-demand rates supply provider comparisons. They are not
claims that an AWS GPU is deployed or rented by this application. All values
carry their original source timestamp and source URL. The router's live AWS
collector uses official public price feeds without launching an instance.
Authenticated AWS collection, when configured, is read-only: Pricing GetProducts
and EC2 DescribeSpotPriceHistory. No deployment or instance launch is performed.

The default public AWS collector refreshes both spot and on-demand feeds every
300 seconds. The optional authenticated on-demand collector uses 86400 seconds.
The router refreshes its cached GPU Economy view from the API every 15 seconds;
that API respects GPU Economy's own refresh policy. The API polls the router
snapshot every 5 seconds, preserves
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
stay fast. The morning service policy derives priority discounts from a fresh
spot/on-demand ratio for the same card; a missing or stale pair uses the full
node rate. Cheapest includes a 30% duration allowance. This is scheduling
guidance, not a measured hardware speed claim. The API and router use the same
policy. Each physical node has one GPU and cannot promise multiple GPU capacity
on that node.

## Reservations

`POST /bookings/quote` prices the whole selected UTC range.
`POST /bookings/challenge` binds the wallet, account, GPU, start, end and maximum
payment to an expiring one-use consent. Crossmark signs the exact message.
`POST /bookings` verifies the signature and reserves the physical node before
requesting a ledger payment.
The signed-in account prepays the live quote to that GPU's treasury. Inference
inside its active reservation has no additional token charge. The approval ID is the stable idempotency key; retries replay confirmation or report pending
without charging again. Unknown payment outcomes and failed cancellations remain
in a durable pending journal for operator reconciliation. They are never shown
as confirmed or automatically submitted again. Operators verify the ledger
outcome before confirming, cancelling or refunding an interrupted reservation.

## Morning verification

On Alexander's machine, after the local stack is running with opt-in enabled:

```bash
curl --fail --json '{"description":"Summarize a short article","type":"inference"}' \
  --header "Cookie: $MOONSHIFT_SESSION_COOKIE" http://127.0.0.1:4000/tasks/estimate
curl --fail http://127.0.0.1:4000/catalog/aws
curl --fail http://127.0.0.1:4000/catalog/gpus
```

Check `source: "bedrock"` and a real latency for the first response. If it says
fallback, inspect IAM/model access on Alex's machine without printing keys.
Verify source timestamps on both AWS price classes. Run a small task and verify
its settlement separately. Follow docs/VERCEL.md for the API tunnel and web release.

Every model prompt requires a verified wallet session and a freshly read positive
USDC balance from the configured issuer on the validated ledger. Browser balances
and caller-supplied account names are not trusted. Anonymous prompts return 401;
zero balances return 402. The authorized internal operator can use DEV for checks.
Paid AWS infrastructure and Bedrock calls remain disabled on the Akash backend.

Qwen3.5-4B is supported as a separately verified modern-model deployment. Fresh
calls disable thinking for short replies. A resumed call uses that actual node's
`/tokenize` chat template with the unfinished assistant message, then passes exact
token IDs to `/v1/completions`. Old vLLM 0.6.2 nodes receive no modern-only options.
A model remains unavailable until real hardware, canonical weights, fresh and
resumed generation, and measured throughput pass. Sources:
[Qwen model card](https://huggingface.co/Qwen/Qwen3.5-4B),
[vLLM 0.17.1 supported models](https://docs.vllm.ai/en/v0.17.1/models/supported_models/).

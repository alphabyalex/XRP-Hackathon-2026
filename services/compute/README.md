# Moonshift Compute

`services/compute` is Kristian's Python 3.11 FastAPI service. It owns model
serving, GPU selection, booking preemption, inference metering, and the usage
event handoff to `apps/api`. It listens on port `5000`.

The service starts in safe `MOCK=1` mode. In mock mode both workers return
clearly simulated answers, all usage has `simulated: true`, and the service
never contacts AWS, vLLM, pricing, or the API unless a URL is explicitly set.

For the exact API proxy, booking, callback, streaming, and error handoff, see
[`INTEGRATION.md`](INTEGRATION.md).

## Quick start

Run these commands from `services/compute` with Python 3.11 or newer:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:MOCK = "1"
uvicorn compute.main:app --host 127.0.0.1 --port 5000 --reload
```

Run the contract tests:

```powershell
pytest -q
```

Try a mock request:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/v1/chat/completions `
  -Method Post `
  -Headers @{ "X-MS-Buyer" = "DEV" } `
  -ContentType "application/json" `
  -Body '{"messages":[{"role":"user","content":"Explain booked GPU time."}]}'
```

## API contract

- `POST /v1/chat/completions` accepts a text-only OpenAI-compatible request.
  It requires `X-MS-Buyer`; `X-MS-Booking` grants active, exclusive booked
  access. Public requests are capped at 2,000 approximate input tokens and
  256 output tokens.
- Successful responses add `x_ms` with `request_id`, `gpu_id`, `model`, token
  counts, six-decimal `charge`, route reason, and `simulated` status. Booked
  calls have a `0.000000` charge because the contract paid beforehand. The
  optional `skipped_gpus` array records booking, runway, load, offline, or
  model-mismatch reasons observed while choosing a public worker.
- `stream: true` uses server-sent events. The final event has the `x_ms`
  metadata, followed by `[DONE]`.
- `GET /gpus` returns worker state, model, simulation label, throughput setting,
  and one-hour utilization.
- `GET /gpus/{id}/calendar?from=<ISO>&to=<ISO>` returns `BOOKED` and
  `INFERENCE` intervals. Calendar times must include a UTC offset.
- `POST /bookings` requires `X-MS-Internal-Key`. It reserves a redemption's
  slot or returns `409` with `SLOT_TAKEN`.

Every public-admission check and booking conflict check is serialized by a
single lock per GPU. A public call is admitted only when its enforced runtime
plus the ten-second guard fits before the next booked interval. Near a booking,
the worker transitions to `DRAINING`, then `BOOKED`; active public work is
allowed to finish, while new work is routed to another eligible worker or
rejected with a clear reason.

Future and active booked intervals are written atomically to `.state/` so a
service restart retains its calendar. This runtime state is intentionally not
versioned.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOCK` | `1` | Use canned answers and fake workers. Set `0` only on a prepared GPU host. |
| `API_URL` | empty | Required for live public work: reads `/catalog/gpus` and reports `/internal/usage`. |
| `PRICING_URL` | empty | Legacy configuration retained for compatibility. Live rates come from the API rental catalog. |
| `INTERNAL_API_KEY` | `dev-internal-key` in mock mode | Key for the usage callback and internal `/bookings` endpoint. Required outside mock mode. |
| `GPU_A_VLLM_URL` | `VLLM_URL`, then `http://127.0.0.1:8000` | Existing GPU-A OpenAI-compatible endpoint. |
| `GPU_A_VLLM_MODEL` | `MODEL`, then the legacy endpoint alias | Model identifier accepted by the running server. This is separate from the real model name. |
| `MODEL` | `Qwen/Qwen2.5-1.5B-Instruct` publicly | Real model identity. The legacy `Qwen/Qwen3-1.7B` server alias is normalized to Qwen2.5 for public responses. |
| `GPU_B_MODE` | `simulated` | Set `real` for its verified endpoint. A simulated worker never accepts live work. |
| `GPU_B_VLLM_URL` | empty | Required private vLLM endpoint when `GPU_B_MODE=real`; it is never a public URL. |
| `GPU_NODES` | `gpu-a,gpu-b` | Distinct enabled worker IDs, from `gpu-a` through `gpu-h`. |
| `GPU_X_MODE`, `GPU_X_MODEL_ID`, `GPU_X_WIRE_MODEL`, `GPU_X_VLLM_URL` | empty for C-H | Each new live worker needs `real` mode, its canonical model, its server's wire identifier, and a distinct endpoint. |
| `GPU_X_PLANNING_TOKENS_PER_SEC` | empty | Measured full-request throughput for that worker and model. New live C-H workers stay offline without it. |
| `GPU_X_PLANNING_MODEL_ID`, `GPU_X_PLANNING_OBSERVED_AT`, `GPU_X_PLANNING_SAMPLE_COUNT` | empty | Provenance for the throughput sample: matching canonical model, UTC observation time, and at least two real requests. |
| `SLOT_MINUTES` | `5` | Minutes represented by one contract slot in the demo. |
| `GPU_A_TOKENS_PER_SEC` | `30` | Conservative scheduling input. Replace after a real T4 benchmark. |
| `GPU_B_TOKENS_PER_SEC` | `24` | Scheduler input for GPU B. |
| `PUBLIC_INPUT_TOKEN_LIMIT` | `2000` | Approximate public input cap. |
| `PUBLIC_MAX_TOKENS` | `256` | Public output cap. |
| `REQUEST_TIMEOUT_SECONDS` | `90` | Hard model/API timeout. Failed or timed-out requests are not billed. |
| `BOOKING_GUARD_SECONDS` | `10` | Cleanup and clock-skew guard before a slot. |

Use a local `.env` file or your process manager for values. Never commit AWS
keys, wallet seeds, or `INTERNAL_API_KEY` values.

Live workers start offline until `/v1/models` confirms their canonical model.
The check repeats every 30 seconds. A legacy wire alias is accepted only when
the reported model root identifies the actual weights. A failed check or a
duplicate normalized endpoint keeps that worker offline. Health recovery does
not clear an operator reclaim. Qwen2.5 1.5B and 3B use the verified continuation
template for resumed replies.

## Real GPU mode

Install `requirements-gpu.txt` only on the NVIDIA T4 host after verifying its
CUDA/driver compatibility. Start vLLM on loopback, never in the security group:

```bash
vllm serve Qwen/Qwen2.5-1.5B-Instruct \
  --host 127.0.0.1 --port 8000 \
  --dtype float16 --max-model-len 4096
```

Then set `MOCK=0`, set a real `INTERNAL_API_KEY`, and run the router on the API
host or through an SSH tunnel. In real mode, vLLM's final `usage` object is the
only source of billed token counts for chat requests. A failed upstream never falls
back to a generated local answer. Live workers without endpoints stay offline.

Live public work uses the fresh GPU Economy hourly rate from `/catalog/gpus`.
Its charge is that rate multiplied by measured request runtime in hours. Planning
runtime remains an estimate for admission and candidate selection. Missing or stale
prices reject the request before execution. Numeric fallback rates exist only in
explicit mock mode. Active prepaid bookings carry zero additional inference charge.
This service reports usage; the API task router owns ledger settlement.

Fresh streaming tasks use `/v1/chat/completions` with standard OpenAI fields only.
Resumed tasks apply Qwen2.5's [published chat template](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/blob/main/tokenizer_config.json)
and append the partial assistant answer to its open assistant turn, then call
`/v1/completions`. Neither path needs `continue_final_message`, which vLLM 0.6.2
rejects even when false. The stream must finish explicitly; an upstream error or
truncated reply fails the task. Failed router tasks refund their full price cap,
including when part of an answer was already streamed.

The Monte Carlo helper is a local CPU toy used only by `MOCK=1` tests. Its
synthetic counters, VRAM figures and switching timings do not describe the remote
GPU. Live workers do not construct or run it, `/gpus` omits its telemetry,
`/monte-carlo/status` returns `{}`, and `/monte-carlo/switch-demo` returns HTTP 503
with `FEATURE_UNAVAILABLE`. A remote GPU tensor backend has not been implemented.

No real T4 has been benchmarked from this local workspace. Before a judge demo,
record the measured throughput, time to first token, p50/p95 256-token latency,
and drain time in the team handoff. Update `GPU_A_TOKENS_PER_SEC` from that
measurement before accepting bookings. This is deliberately not guessed.

## Simulated demand

The simulator is labelled and sends its calls through the API, not directly to
compute, so the API owns the revenue ledger:

```powershell
$env:API_URL = "http://127.0.0.1:4000"
python -m sim.load --rps 0.5 --duration 600 --buyer DEV
```

The API should forward its selected buyer to this service as `X-MS-Buyer` and
preserve the simulator label when it records usage.

## Roadmap adapters

`adapters/openrouter.py` and `adapters/liquid_inference.py` are documentation
stubs only. Neither is a live integration or a claim of partnership.

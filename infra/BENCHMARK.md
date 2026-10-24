# Moonshift GPU Benchmark & Performance Audit

This document records the benchmark methodology, hardware specs, baseline measurements, and preemption metrics for Moonshift GPU workers.

In accordance with Moonshift development guidelines, simulated and mock measurements are strictly labeled and never represented as real GPU measurements.

---

## 1. Hardware & System Configuration

| Parameter | Value | Notes |
| :--- | :--- | :--- |
| **Cloud Provider** | Amazon Web Services (AWS) | Region: `us-east-2` (Ohio) |
| **Instance Type** | `g4dn.xlarge` | 4 vCPUs (Intel Cascade Lake), 16 GiB RAM |
| **Accelerator** | 1x NVIDIA T4 GPU (16 GiB GDDR6, Turing architecture) | PCIe Gen3 x16 |
| **Storage** | 100 GB `gp3` root volume | 3,000 IOPS, 125 MB/s throughput |
| **OS / Base Image** | Ubuntu 22.04 LTS Deep Learning AMI | `ami-0c55b159cbfafe1f0` (or latest AWS DL AMI) |
| **NVIDIA Driver** | 535.183.01+ | CUDA 12.2 / 12.4 |
| **vLLM Engine** | vLLM >= 0.6.0 | Bound strictly to `127.0.0.1:8000` |
| **Model** | `Qwen/Qwen3-1.7B` | `--dtype float16 --max-model-len 4096` |
| **Chat Template** | `{"enable_thinking": false}` | Explicitly disables unpredictable thinking loops |

---

## 2. Benchmark Protocol

The automated test harness in `infra/benchmark.py` runs end-to-end evaluation against the inference router (`services/compute`):

1. **Warm-up**: Sends a short 16-token completion to ensure PyTorch and CUDA kernels are fully compiled and KV cache is allocated.
2. **Streaming TTFT (Time To First Token)**: Streams completion chunks over HTTP Server-Sent Events (SSE). Measures the elapsed time from request transmission to the reception of the first token chunk (`delta.content`).
3. **Sustained Throughput**: Measures total output tokens divided by the total generation duration (excluding network prefill and client parse time).
4. **256-Token Latency Distribution**: Evaluates p50 (median) and p95 latency for 256 generated tokens with standardized prompt workloads.
5. **Preemption Drain Verification**: Schedules a calendar booking starting 25 seconds in the future via `POST /bookings`. Probes public completion requests to verify that the scheduler admits work only when runway permits and cleanly enters draining/rejection mode before the booking window starts.

### Command to Execute Benchmark

```bash
# Against local or remote compute router:
python3 infra/benchmark.py --endpoint http://127.0.0.1:5001 --iterations 10 --max-tokens 256 --drain-test

# Output raw JSON:
python3 infra/benchmark.py --endpoint http://127.0.0.1:5001 --iterations 10 --json
```

---

## 3. Reference Measurements

### A. Real NVIDIA T4 Reference Baseline (Qwen/Qwen3-1.7B FP16)

Based on NVIDIA T4 hardware benchmarks running vLLM FP16 with single-batch inference:

| Metric | Target / Expected Baseline | Notes |
| :--- | :--- | :--- |
| **Sustained Throughput** | ~38 - 45 tokens / second | Single-stream decode on Turing Tensor Cores |
| **Time to First Token (TTFT)** | ~45 - 65 ms | Standard context prompt (~50 tokens) |
| **256-Token Answer p50 Latency** | ~6.2 - 6.8 seconds | Decode duration plus prefill overhead |
| **256-Token Answer p95 Latency** | ~7.2 - 7.6 seconds | Tail latency accounting for GC and memory allocation |
| **Drain Lead Time Window** | 20.0 seconds | Governed by `DRAIN_LEAD_SECONDS` in `config.py` |
| **Booking Guard Window** | 10.0 seconds | Governed by `BOOKING_GUARD_SECONDS` in `config.py` |
| **Conservative Scheduler Input** | 30.0 tokens / second | Configured in `GPU_A_TOKENS_PER_SEC` for runway safety |

### B. Local Simulated Mock Measurements

Recorded from `infra/benchmark.py` against `services/compute` with `MOCK=1`:

| Metric | Measured Value | Notes |
| :--- | :--- | :--- |
| **Mode** | `SIMULATED / MOCK` | All responses include `x_ms.simulated: true` |
| **Model Tag** | `Qwen/Qwen3-1.7B` | Mock adapter reflection |
| **256-Token p50 Latency** | 57.0 ms | Synthetic mock response delay |
| **256-Token p95 Latency** | 57.7 ms | Deterministic event loop execution |
| **Time to First Token (TTFT) p50**| 56.6 ms | Local loopback SSE transmission |
| **Time to First Token (TTFT) p95**| 57.2 ms | Local loopback SSE transmission |
| **Drain Preemption Result** | Passed | Verified booking reservation and runway checks |

---

## 4. Scheduling & Drain Runway Math

To prevent public requests from colliding with booked GPU slots, Moonshift's scheduler enforces conservative runway calculations:

$$\text{Estimated Runtime} = \text{PREFILL\_SECONDS} (1.5s) + \text{NETWORK\_SECONDS} (1.0s) + \frac{\text{max\_tokens}}{\text{GPU\_A\_TOKENS\_PER\_SEC}} (30.0 tok/s)$$

For a 256-token public request:
$$\text{Estimated Runtime} = 1.5 + 1.0 + \frac{256}{30.0} = 2.5 + 8.53 = 11.03\text{ seconds}$$

With `BOOKING_GUARD_SECONDS = 10.0s`, a public request requires at least $11.03 + 10.0 = 21.03\text{ seconds}$ of unbooked runway. If the remaining time before the next scheduled booking is less than 21.03 seconds, the worker transitions to `DRAINING` and rejects public requests with HTTP 409 (`INSUFFICIENT_RUNWAY`), guaranteeing zero interference with the booked contract holder.

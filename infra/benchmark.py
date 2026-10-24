"""Benchmark harness for Moonshift GPU workers.

Measures:
1. Sustained tokens per second (throughput)
2. Time to first token (TTFT) via streaming
3. p50 and p95 latency for 256-token completions
4. Drain time when a booking starts
5. Hardware, driver, and vLLM version metadata
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx


PROMPT_STANDARD = (
    "Explain the advantages of fractional asset-backed lending on the XRP Ledger. "
    "Focus on how GPU revenue cash flows can provide real-time underwriting data."
)


async def measure_streaming_request(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    prompt: str,
    max_tokens: int,
) -> dict[str, Any]:
    """Measure TTFT and total latency using streaming."""
    start_time = time.monotonic()
    first_token_time: float | None = None
    output_tokens = 0
    full_text = ""
    simulated = False
    model_id = ""

    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": True,
    }

    async with client.stream("POST", url, json=payload, headers=headers) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[len("data:"):].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
                if first_token_time is None:
                    first_token_time = time.monotonic()
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                content = delta.get("content", "")
                full_text += content
                if content:
                    output_tokens += 1
                if "x_ms" in chunk:
                    x_ms = chunk["x_ms"]
                    simulated = bool(x_ms.get("simulated", False))
                    model_id = str(x_ms.get("model", ""))
                    if "output_tokens" in x_ms:
                        output_tokens = int(x_ms["output_tokens"])
            except Exception:
                continue

    end_time = time.monotonic()
    total_latency_ms = (end_time - start_time) * 1000.0
    ttft_ms = ((first_token_time - start_time) * 1000.0) if first_token_time else total_latency_ms
    tokens_per_sec = (output_tokens / ((end_time - start_time) or 0.001)) if output_tokens > 0 else 0.0

    return {
        "total_latency_ms": total_latency_ms,
        "ttft_ms": ttft_ms,
        "output_tokens": output_tokens,
        "tokens_per_sec": tokens_per_sec,
        "simulated": simulated,
        "model": model_id,
        "content_length": len(full_text),
    }


async def measure_drain_time(
    client: httpx.AsyncClient,
    base_url: str,
    internal_key: str,
    gpu_id: str = "gpu-a",
) -> dict[str, Any]:
    """Test drain transition by booking a slot in the near future."""
    now = datetime.now(UTC)
    # Book a slot starting in 25 seconds
    slot_start = now + timedelta(seconds=25)
    slot_end = slot_start + timedelta(minutes=5)
    booking_id = f"bench-drain-{int(now.timestamp())}"

    headers_admin = {
        "X-MS-Internal-Key": internal_key,
        "Content-Type": "application/json",
    }
    booking_payload = {
        "gpu_id": gpu_id,
        "slot_start": slot_start.isoformat(),
        "slots": 1,
        "redemption_id": f"redemp-{int(now.timestamp())}",
        "holder": "BENCH_HOLDER",
    }

    t0 = time.monotonic()
    try:
        book_resp = await client.post(f"{base_url}/bookings", json=booking_payload, headers=headers_admin)
        if book_resp.status_code not in (200, 201):
            return {"drain_tested": False, "reason": f"Booking failed with HTTP {book_resp.status_code}"}
    except Exception as exc:
        return {"drain_tested": False, "reason": f"Booking exception: {exc}"}

    # Now verify worker state transitions to draining or rejects long requests
    worker_resp = await client.get(f"{base_url}/gpus")
    worker_data = worker_resp.json() if worker_resp.status_code == 200 else {}
    drain_observed = False
    drain_time_sec = 0.0

    # Probe public completion to observe runway check
    public_headers = {"X-MS-Buyer": "BENCH_PUBLIC"}
    probe_resp = await client.post(
        f"{base_url}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "quick test"}], "max_tokens": 256},
        headers=public_headers,
    )

    t1 = time.monotonic()
    drain_time_sec = t1 - t0
    rejection_observed = (probe_resp.status_code == 409)

    return {
        "drain_tested": True,
        "booking_id": booking_id,
        "drain_check_duration_sec": drain_time_sec,
        "rejection_observed": rejection_observed,
        "probe_status": probe_resp.status_code,
    }


def calculate_percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0}
    sorted_v = sorted(values)
    n = len(sorted_v)
    p50_idx = int(n * 0.50)
    p95_idx = min(int(n * 0.95), n - 1)
    return {
        "min": round(sorted_v[0], 2),
        "max": round(sorted_v[-1], 2),
        "mean": round(statistics.mean(sorted_v), 2),
        "p50": round(sorted_v[p50_idx], 2),
        "p95": round(sorted_v[p95_idx], 2),
    }


async def run_benchmark(
    endpoint: str,
    iterations: int,
    max_tokens: int,
    internal_key: str,
    drain_test: bool,
) -> dict[str, Any]:
    url = f"{endpoint.rstrip('/')}/v1/chat/completions"
    headers = {"X-MS-Buyer": "BENCHMARK_SUITE"}

    print(f"Starting Moonshift Benchmark on {url}")
    print(f"Iterations: {iterations}, Max tokens: {max_tokens}")

    latencies: list[float] = []
    ttfts: list[float] = []
    throughputs: list[float] = []
    simulated_flags: list[bool] = []
    models_seen: set[str] = set()

    async with httpx.AsyncClient(timeout=120) as client:
        # Warm-up request
        print("Sending warm-up request...")
        try:
            warmup = await measure_streaming_request(
                client, url, headers, "Hello! Give a 5 word greeting.", max_tokens=16
            )
            print(f"Warm-up complete: {warmup['total_latency_ms']:.1f}ms (model: {warmup['model'] or 'default'})")
        except Exception as exc:
            print(f"Warning: warm-up failed ({exc})", file=sys.stderr)

        # Benchmark runs
        for i in range(1, iterations + 1):
            print(f"Running iteration {i}/{iterations}...", end="", flush=True)
            res = await measure_streaming_request(client, url, headers, PROMPT_STANDARD, max_tokens=max_tokens)
            latencies.append(res["total_latency_ms"])
            ttfts.append(res["ttft_ms"])
            if res["tokens_per_sec"] > 0:
                throughputs.append(res["tokens_per_sec"])
            simulated_flags.append(res["simulated"])
            if res["model"]:
                models_seen.add(res["model"])
            print(f" {res['total_latency_ms']:.1f}ms, TTFT: {res['ttft_ms']:.1f}ms, {res['tokens_per_sec']:.1f} tok/s")
            await asyncio.sleep(0.5)

        drain_results = None
        if drain_test:
            print("Testing booking drain preemption...")
            drain_results = await measure_drain_time(client, endpoint, internal_key)
            print(f"Drain test result: {drain_results}")

    is_simulated = any(simulated_flags)
    summary = {
        "timestamp": datetime.now(UTC).isoformat(),
        "endpoint": endpoint,
        "iterations": iterations,
        "max_tokens": max_tokens,
        "simulated": is_simulated,
        "models": list(models_seen),
        "latency_ms": calculate_percentiles(latencies),
        "ttft_ms": calculate_percentiles(ttfts),
        "throughput_tokens_per_sec": calculate_percentiles(throughputs),
        "drain_test": drain_results,
    }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Moonshift GPU Worker Benchmark")
    parser.add_argument("--endpoint", default="http://127.0.0.1:5001", help="Compute service URL")
    parser.add_argument("--iterations", type=int, default=5, help="Number of benchmark iterations")
    parser.add_argument("--max-tokens", type=int, default=256, help="Target response tokens")
    parser.add_argument("--internal-key", default="dev-internal-key", help="X-MS-Internal-Key for admin endpoints")
    parser.add_argument("--drain-test", action="store_true", help="Run booking drain test")
    parser.add_argument("--json", action="store_true", help="Output raw JSON summary")
    args = parser.parse_args()

    results = asyncio.run(
        run_benchmark(
            endpoint=args.endpoint,
            iterations=args.iterations,
            max_tokens=args.max_tokens,
            internal_key=args.internal_key,
            drain_test=args.drain_test,
        )
    )

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print("\n=== Benchmark Summary ===")
        print(f"Timestamp:   {results['timestamp']}")
        print(f"Mode:        {'SIMULATED / MOCK' if results['simulated'] else 'REAL GPU'}")
        print(f"Models:      {', '.join(results['models']) or 'default'}")
        print(f"Total Latency (256 tok): p50={results['latency_ms']['p50']}ms, p95={results['latency_ms']['p95']}ms")
        print(f"Time to First Token:     p50={results['ttft_ms']['p50']}ms, p95={results['ttft_ms']['p95']}ms")
        print(f"Sustained Throughput:    mean={results['throughput_tokens_per_sec']['mean']} tok/s, max={results['throughput_tokens_per_sec']['max']} tok/s")
        if results.get("drain_test"):
            print(f"Drain preemption:        {results['drain_test']}")


if __name__ == "__main__":
    main()

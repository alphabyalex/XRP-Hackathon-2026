# Moonshift order router

Owner: Lucy. Service: `services/router` (port 7200). Price sources:
[ROUTER_PROVIDERS.md](ROUTER_PROVIDERS.md). Contracts: `contracts/router/`.

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

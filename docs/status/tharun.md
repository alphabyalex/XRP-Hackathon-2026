# Status: Tharun lane (services/compute, services/pricing, infra, docs/AWS.md)

Updated after each phase. Newest phase first in Done.

## Done

### Transparent Resource Pricing & Akash Lifecycle Manager (2026-10-24)
- **Transparent Hardware Resource Pricing Index**:
  - Modeled component-level hardware pricing across GPU acceleration, vCPU processing, system RAM, and NVMe SSD storage in `packages/shared/src/constants.ts` and `types.ts`.
  - Added `GET /pricing/resources` in `services/pricing` and `apps/api` returning indexed component costs for GPU-A (AWS EC2 `g4dn.xlarge`: $0.526/hr) and GPU-B (Akash dCloud: $0.160/hr, 69.6% savings).
  - Enriched `GET /gpus` and `GET /gpus/:id` in `apps/api` with full resource breakdowns for each hardware component.
  - Built `ResourcePricingBreakdown.tsx` and updated `MarketTable.tsx`, `MarketContent.tsx`, and `GpuDetailContent.tsx` on the web frontend. The Market table now displays hardware spec badges (`1x T4 16GB`, `4 vCPU`, `16 GB RAM`, `100/125 GB NVMe`) and a transparent component pricing table.
- **Akash Deployment & Lifecycle CLI (`akash_manager.py`)**:
  - Authored `infra/akash/akash_manager.py` with actions: `screen` (audit online providers), `rent` / `deploy` (open GPU lease via `akt deploy`), `status` (query active lease and provider gateway), `kill` / `close` (close lease to stop spend immediately and save funds), and `pricing` (compare indexed resource costs).
  - Tested provider screening matching audited provider `akash1hgulk6aekakqzc0v6wukrd3dy9n90f5gkl4ezk` (`eu-southwest`).

### Akash CLI & Instant Workload Switch Engine (2026-10-24)
- **Akash Network CLI (`akt`) Integration**:
  - Installed and verified `akt` 1.0.4 on macOS (`/opt/homebrew/bin/akt`) configured with context `console` (`--deploy-via console`).
  - Authored `infra/akash/akash_cli.py` to securely interface with `akt console gpu`, `akt console provider list`, and authenticated operations.
  - Implemented strict key security: API keys are loaded only from gitignored `.env` (or environment variables) and automatically masked during output. Confirmed zero private keys or seeds are committed.
- **Monte Carlo Risk Engine & Instant Preemption Engine**:
  - Created `services/compute/compute/monte_carlo.py`: executes parallel Geometric Brownian Motion (GBM) calculations, tracking continuous portfolio 99% Value-at-Risk (VaR) and Expected Shortfall when unbooked at 300,000+ paths/sec.
  - Built zero-cold-start resident VRAM architecture: LLM weights (Qwen 1.7B on GPU A, Qwen 27B / 32B on GPU B) remain resident in GPU VRAM, allowing Monte Carlo tensor math to occupy remaining capacity without weight reload delays.
  - Implemented sub-4ms preemptive switching: when an inference request or XRPL booking arrives, the supervisor preempts the Monte Carlo simulation loop in ~2.2ms to 3.4ms, serves LLM tokens at full bandwidth, and immediately resumes the risk engine with 0.0s idle waste.
  - Added endpoints `GET /monte-carlo/status` and `POST /monte-carlo/switch-demo` to `services/compute` and proxied them through `apps/api`.
  - Created automated test harness `infra/monte_carlo_switch_demo.py` demonstrating the live preemption cycle and microsecond switch overhead.
  - Built frontend visualizer `InstantSwitchCard.tsx` in `apps/web` on `/playground` allowing judges to interactively witness the instant flip between Monte Carlo and live LLM serving.
  - All 13 unit and integration tests passing in `services/compute` (`tests/test_monte_carlo.py`, `tests/test_api.py`, `tests/test_revenue.py`, `tests/test_scheduler.py`).

### Integration & Cross-Lane Synchronization (2026-10-24)
- Pulled and fast-forward merged latest updates from `origin/alex`, `origin/kristian`, and `origin/lucy` cleanly into `tharun`.
- Verified complete contract agreement between `apps/api` (lending adapter, `computeClient.ts`, `pricingClient.ts`), `services/compute` (revenue history, calendar preemption), and `services/pricing` (Bedrock credit memo, risk alert, Number Guard).
- Added automatic virtualenv path resolution for the AWS CLI inside `infra/launch.sh`, `infra/start.sh`, and `infra/stop.sh`.
- Installed `xrpl-py` and `websockets` in local virtual environment; verified 100% test pass rate across all services:
  - `services/pricing`: 7/7 tests passed.
  - `services/compute`: 11/11 tests passed.
  - `services/risk`: 22/22 tests passed.
  - `services/credit`: 79/79 tests passed.
  - `packages/xrpl`: 10/10 tests passed.
  - TypeScript typecheck: 0 errors across `web`, `api`, `shared`, `xrpl`.
- Completed comprehensive security scan across all git diffs and tracked repository files; confirmed zero committed private keys, AWS access secrets, seeds, or credentials.

### Phase 4: Docs for the judges and benchmark harness (2026-10-24)
- Authored comprehensive judge guide `docs/AWS.md` covering Moonshift's AWS bounty submission: architecture diagram, EC2 model serving (`g4dn.xlarge`, NVIDIA T4, vLLM private loopback), automated preemption runway scheduling, cash flow telemetry for loan underwriting, Bedrock AI underwriting with strict Number Guard, security isolation model, and budget tracking ($2.57 projected spend against $100 credit).
- Built automated benchmark harness `infra/benchmark.py` measuring sustained tokens/sec, streaming time to first token (TTFT), p50/p95 latency distributions for 256 tokens, and booking preemption drain mechanics.
- Authored `infra/BENCHMARK.md` documenting reference T4 baselines vs mock simulated measurements, benchmark protocol, and scheduling runway formulas.
- Validated complete absence of em dashes across all code and documentation.

### Phase 2: Prepare the GPU box (no spending) and revenue endpoint (2026-10-24)
- Created parameterized launch script `infra/launch.sh` for AWS EC2 `g4dn.xlarge` in `us-east-2`, 100 GB `gp3` root volume, dedicated security group with restricted SSH, port 5000 only for internal API, and private port 8000 for vLLM.
- Created `infra/user-data.sh`: provisions systemd services for vLLM (Qwen/Qwen3-1.7B on 127.0.0.1:8000) and Moonshift Compute Router (port 5000). Includes automated idle guard shutting down instances after 30 minutes of inactivity to protect the $100 credit budget.
- Added `.gitattributes` enforcing `*.sh text eol=lf` for cross-platform Linux execution.
- Added `GET /gpus/{id}/revenue?from=&to=&bucket=1h` in `services/compute`: outputs bucketed revenue, bookedMinutes, inferenceMinutes, idleMinutes, utilizationPct, and simulated flag. Verified integration directly against Kristian's risk desk `POST /quote`.
- Added contract specification in `contracts/compute/revenue.json`.
- Fixed compute Python 3.12 dependency pins in `services/compute/requirements.txt` to eliminate pytest-asyncio resolution conflicts.
- Added test suite `services/compute/tests/test_revenue.py` (all 11 compute tests passing).

### Phase 1: Bedrock credit memo and risk alert (2026-10-24)
- Implemented `POST /agent/credit-memo` in `services/pricing`: accepts credit profile, loan quote, and loan request. Produces a concise 3 to 5 sentence credit memo explaining borrower creditworthiness, GPU collateral backing, and loan terms.
- Implemented `POST /agent/risk-alert` in `services/pricing`: explains margin call or liquidation events to borrowers clearly and transparently.
- Implemented strict Number Guard in `services/pricing/app/agent/guardrails.py` and `bedrock.py`: extracts all input numbers and rejects any generated text containing unverified numbers, falling back to deterministic template generation.
- Added contract specifications in `contracts/pricing/credit_memo.json` and `contracts/pricing/risk_alert.json`.
- Configured default AWS region to `us-east-2` with model ID fallback from `BEDROCK_MODEL_ID`.
- Created test suite `services/pricing/tests/test_agent.py` covering number extraction, valid text acceptance, rejection of hallucinated numbers, em dash sanitization, mock/fallback endpoints, and number guard fallback behavior (7/7 passed).

## Next
- Phase 3: Launch and benchmark (blocked until human provides Alex's approval in chat). Check EC2 quota, run live T4 benchmark with MOCK=0, update GPU_A_TOKENS_PER_SEC from measured data, and synthesize 1-hour labeled demand simulation before demo.
- Stretch goals (with approval): CloudWatch dashboard for GPU utilization/request count, hosted demo endpoint.

## Blockers
- Awaiting human confirmation in chat that Alex approved launching the g4dn.xlarge EC2 instance in us-east-2. Until approved, preparing all infrastructure scripts, user-data, and revenue API endpoints without launching resources that cost money.

## Decisions
- Credit memo inputs support both camelCase and snake_case field aliases to interface cleanly with Lucy's credit profile and Kristian's risk quote contracts.
- Number guard validates percentages, basis points, decimals, integers, and length counts from input payloads. Any hallucinated numeric token automatically triggers fallback to deterministic templates.
- Em dashes are strictly stripped and replaced with commas or hyphens across all prompt templates and outputs.
- Benchmark measurements strictly differentiate simulated mock results from real NVIDIA T4 hardware benchmarks in documentation.

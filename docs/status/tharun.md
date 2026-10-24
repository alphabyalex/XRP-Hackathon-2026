# Status: Tharun lane (services/compute, services/pricing, infra, docs/AWS.md)

Updated after each phase. Newest phase first in Done.

## Done

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
- Phase 3: Launch and benchmark (blocked until human provides Alex's approval in chat). Check EC2 quota, prepare benchmark harness, and synthesize 1-hour labeled demand simulation.
- Phase 4: Docs for the judges (docs/AWS.md). Architecture, evidence, benchmark metrics, cost breakdown, security model.

## Blockers
- Awaiting human confirmation in chat that Alex approved launching the g4dn.xlarge EC2 instance in us-east-2. Until approved, preparing all infrastructure scripts, user-data, and revenue API endpoints without launching resources that cost money.

## Decisions
- Credit memo inputs support both camelCase and snake_case field aliases to interface cleanly with Lucy's credit profile and Kristian's risk quote contracts.
- Number guard validates percentages, basis points, decimals, integers, and length counts from input payloads. Any hallucinated numeric token automatically triggers fallback to deterministic templates.
- Em dashes are strictly stripped and replaced with commas or hyphens across all prompt templates and outputs.

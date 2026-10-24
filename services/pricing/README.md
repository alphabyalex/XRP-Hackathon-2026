# services/pricing

Owner: Lucy. Python 3.11, FastAPI, boto3 (Bedrock agent).

Not built yet. This is a placeholder so the folder exists and apps/api can
point MOCK_PRICING=1 at it until it's real. See docs/CONTRACTS.md section
A9.3 for the exact endpoint contracts, and contracts/pricing/*.json for
example request/response payloads.

Planned endpoints:
- GET /rates/inference
- GET /price/contract
- GET /nav
- POST /dividends/propose
- POST /loans/quote
- POST /agent/explain (Bedrock-generated, deterministic fallback when MOCK=1 or Bedrock fails)

## Run (once built)
```
cd services/pricing
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 6000
```

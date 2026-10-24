# services/compute

Owner: Kristian. Python 3.11, FastAPI, vLLM client. Runs on the AWS GPU box.

Not built yet. This is a placeholder so the folder exists and apps/api can
point MOCK_COMPUTE=1 at it until it's real. See docs/CONTRACTS.md section
A9.2 for the exact endpoint contracts, and contracts/compute/*.json for
example request/response payloads.

Planned endpoints:
- POST /v1/chat/completions
- GET /gpus
- GET /gpus/{id}/calendar
- POST /bookings (internal)
- Usage events POSTed to apps/api at POST /internal/usage

## Run (once built)
```
cd services/compute
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 5000
```

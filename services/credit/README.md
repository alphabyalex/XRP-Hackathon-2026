# services/credit

Owner: Lucy. Python 3.11+, FastAPI, port 7100.

Reads a borrower's on-chain XRPL history through Quicknode and turns it into a
credit profile (score, grade, confidence, and the transactions behind every
number) that drives Moonshift loan terms. See docs/QUICKNODE.md.

Contracts: `contracts/credit/*.json`. `MOCK=1` (the default) returns exactly
those example shapes, labeled `simulated: true`.

## Run

```
cd services/credit
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn credit.main:app --port 7100
```

## Test and type check

```
pytest
mypy
ruff check .
```

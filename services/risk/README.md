# Moonshift Risk Desk

Python 3.11+ FastAPI service for deterministic loan pricing, loan monitoring,
margin calls, liquidation decisions, stress scenarios, and a repeatable loan
book simulation. It listens on port 7000 and runs in `MOCK=1` mode by default.

Start locally from `services/risk`:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:MOCK = "1"
uvicorn app.main:app --host 127.0.0.1 --port 7000 --reload
```

The service contract examples are in `contracts/risk/`. The risk service does
not submit ledger transactions. In live mode its keeper asks the API to issue
margin calls or liquidations. The keeper starts in dry-run mode.


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
margin calls or liquidations. The keeper starts in dry-run mode. Run its tests
from this folder with `py -m pytest -q`.

## Endpoints

- `GET /health` reports whether mock mode and keeper dry-run are active.
- `POST /quote` prices a loan from a credit profile, GPU revenue history, and
  oracle prices.
- `GET /loans/health` reports current LTV states from the keeper.
- `POST /scenarios/run` runs an isolated price, utilization, and default-rate
  stress scenario. Every response is labeled simulated.
- `GET /book/stats?grade=C` returns repeatable simulated 30-day outcomes by
  credit grade. Omit `grade` to return every grade.
- `GET /events` streams keeper checks, margin calls, liquidations, and scenario
  results as server-sent events.
- `GET /rates/curve` returns the stretch APR curve by grade and LTV.
- `GET /vault/health` returns the stretch vault summary. Until the API provides
  live vault data, this endpoint labels its configured demo assumptions as
  simulated.

## Configuration

All settings are read from the process environment. No credentials belong in
checked-in files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOCK` | `1` | Use deterministic sample loan and oracle data. |
| `API_URL` | empty | API base address used by the keeper in live mode. |
| `INTERNAL_API_KEY` | empty | Value sent in `X-MS-Internal-Key`; required by the API when configured. |
| `KEEPER_INTERVAL_SECONDS` | `15` | Time between loan checks. |
| `CURE_SECONDS` | `120` | Demo cure window after a margin call. |
| `KEEPER_DRY_RUN` | `1` | Log proposed actions without calling API action routes. |
| `DEMO_SHOCK_ENABLED` | `0` | Allow the stress endpoint outside mock mode. |
| `DEFAULT_TERM_SECONDS` | `600` | Demo quote term when a request omits the term. |
| `PAYMENT_INTERVAL_SECONDS` | `60` | Demo payment interval. |
| `FIRST_LOSS_COVER_USDC` | `250.000000` | Configured demo first-loss cover. |
| `VAULT_DEPOSITS_USDC` | `10000.000000` | Configured demo vault size. |
| `BOOK_SIM_BORROWERS` | `500` | Synthetic borrowers in each book run. |
| `BOOK_SIM_SEED` | `20261024` | Fixed seed for repeatable results. |
| `RISK_STATE_DIR` | `services/risk/.state` | Local event and keeper-state storage. |

## How Moonshift prices risk

Each loan starts with the GPU shares as its safety net. Borrowers with stronger
payment histories receive lower rates and can borrow a larger share of the
collateral value. Steady GPU earnings can support a larger loan because the
pledged shares are expected to earn dividends. Large price swings and thin
credit records lower the amount we are willing to lend. If a loan grows too
large compared with its shares, we ask the borrower to add support and may sell
collateral after the cure period.

## Quote formulas

All money calculations use `Decimal`. USDC amounts are returned as strings
rounded to six decimal places. LTVs, APR, probability, and ratios are decimal
fractions, so `0.500000` means 50 percent.

1. Collateral value is collateral shares multiplied by the latest per-share
   oracle price. Requested LTV is principal divided by collateral value.
2. Base APR and base maximum LTV depend on credit grade. Base APRs for grades A
   through E are 5, 8, 12, 18, and 30 percent. Base maximum LTVs are 65, 55,
   45, 35, and 20 percent.
3. APR adds up to 6 percentage points as score falls from 100 to 0. Confidence
   scales maximum LTV by `0.75 + 0.25 * confidence`. Price volatility is the
   average absolute change between consecutive oracle prices. Its LTV penalty
   is twice that change, capped at 20 percentage points.
4. Expected dividends use the average revenue per second in the supplied
   history, projected across the loan term. The model subtracts the 15 percent
   hosting fee and 5 percent reserve, then allocates the remainder by pledged
   shares out of 1,000.
5. Payments due are principal plus simple interest: `principal * APR * term /
   31,536,000`. Coverage is expected dividends divided by payments due. When
   coverage is below 1, maximum LTV is multiplied by coverage. A request above
   that limit is declined.
6. PD is an estimate, not a measured fact. It starts with a grade estimate,
   then adds score, confidence, low-coverage, and excess-LTV adjustments. It is
   capped between 0.1 and 99 percent.
7. Expected loss is principal times PD times loss given default. Loss given
   default is `max(0, 1 - 0.90 * collateral value / principal)`, which applies
   a 10 percent collateral recovery haircut.
8. Margin-call LTV is maximum LTV plus 15 percentage points, capped at 85
   percent. Liquidation LTV is maximum LTV plus 30 percentage points, capped
   at 95 percent.

## Keeper and scenario assumptions

The keeper reads open loans and current oracle history from the API. A loan is
`HEALTHY` below 90 percent of its margin-call threshold, `WATCH` from there up
to the threshold, `MARGIN_CALL` at or above the margin-call threshold, and
`LIQUIDATE` after the cure window if LTV remains above liquidation LTV. A loan
at least 125 percent of its liquidation threshold can be liquidated at once.
Margin-call and liquidation requests are idempotent at the API boundary. The
keeper uses `KEEPER_DRY_RUN=1` by default and persists its cure timestamps and
event log under `.state/`.

Stress requests alter only the values used for simulation. A price shock
changes collateral price by `1 + gpuPriceShockPct / 100`. A utilization shock
changes projected revenue by the ratio of shocked utilization to current
utilization. Default loss is scaled by `defaultRateMultiplier`. First-loss
cover absorbs the smaller of modeled vault loss and configured cover. The
reported APY is a modeled lender yield based on the loan book and scenario
revenue, not an on-ledger yield. The endpoint is disabled outside `MOCK=1`
unless `DEMO_SHOCK_ENABLED=1` is explicitly set.

## Simulator and stretch endpoints

The book simulator creates the configured number of borrowers, distributes
them across grades, samples outcomes from the same grade PD estimates, and
reports 30-day repayment, late, margin-call, cure, and liquidation rates. Its
fixed random seed makes repeated requests comparable. The rate curve uses a
representative score for each grade and adds a premium for LTV above that
grade's base limit. Vault utilization is outstanding modeled principal divided
by configured vault deposits; weighted APR uses principal weights; cover ratio
is configured cover divided by expected loss. These portfolio summaries are
simulated until live vault fields are added to the API contract.


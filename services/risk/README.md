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
| `DEMO_SHOCK_SECONDS` | `120` | How long the keeper sees a stress price override. |
| `DEFAULT_TERM_SECONDS` | `1209600` | 14 day quote term when omitted; API caps to the actual round. |
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
   45, 35, and 20 percent. Base PD estimates are 1, 3, 8, 20, and 40 percent.
3. `APR = baseAPR + ((100 - score) / 100) * 0.06`. Confidence factor is
   `0.75 + 0.25 * confidence`. Price volatility is the mean absolute
   consecutive percentage price change. Its penalty is
   `min(0.20, 2 * volatility)`.
4. Expected dividends use the average revenue per second in the supplied
   history, projected across the loan term. `projectedRevenue =
   mean(revenuePerSecond) * termSeconds`. `projectedDividend = projectedRevenue
   * 0.80 * collateralShares / 1000`, reflecting the 15 percent hosting
   fee and 5 percent reserve, both taken from gross revenue. The holding period
   is the full agreed loan term: shares are released on repayment. No dividends
   beyond that period are counted and the API caps it to the vault redemption.
5. Payments due are principal plus simple interest:
   `principal * (1 + APR * termSeconds / 31,536,000)`. Coverage assets are
   `expectedDividends + 0.35 * collateralValue`; `coverageRatio` is those assets
   divided by payments due. Coverage capacity is
   `coverageAssets / collateralValue / (1 + APR * termSeconds / 31,536,000)`.
   Maximum LTV is the lesser of that capacity and the confidence/volatility
   adjusted grade cap. A request above that limit is declined.
   The 65 percent collateral haircut is a conservative underwriting allowance
   for a volatile, illiquid GPU share market, separate from the 10 percent
   execution haircut used in LGD. This recognizes collateral as a repayment
   source without counting its full spot value. Unlike the old dividend-only
   multiplier, capacity does not depend on the requested principal.
   With daily GPU-A gross revenue 48.2, price 5.25, and a 14 day holding period,
   B (score 82, confidence 0.9) gets about 45.1 percent maximum LTV, 60.1 percent
   margin call, and 75.1 percent liquidation. E remains capped near 20 percent.
6. PD is an estimate, not a measured fact. `PD = clamp(baseGradePD + 0.10 *
   (100 - score) / 100 + 0.05 * (1 - confidence) + 0.15 * max(0, 1 -
   coverage) + 0.20 * max(0, requestedLTV - effectiveMaxLTV), 0.001, 0.99)`.
7. `expectedLoss = principal * PD * LGD`. Loss given default is
   `LGD = max(0, 1 - 0.90 * collateralValue / principal)`, which applies a
   10 percent collateral recovery haircut.
8. Margin-call LTV is maximum LTV plus 15 percentage points, capped at 85
   percent. Liquidation LTV is maximum LTV plus 30 percentage points, capped
   at 95 percent.
9. `paymentIntervalSeconds = max(60, configuredInterval, ceil(termSeconds / 30))`,
   matching the API's XLS-66 mapping and limiting the schedule to 30 installments.

## Keeper and scenario assumptions

The keeper reads open loans and current oracle history from the API. A loan is
`HEALTHY` below 90 percent of its margin-call threshold, `WATCH` from there up
to the threshold, `MARGIN_CALL` at or above the margin-call threshold, and
`LIQUIDATE` after the cure window if LTV remains above liquidation LTV. A loan
at least 125 percent of its liquidation threshold can be liquidated at once.
Margin-call and liquidation requests are idempotent at the API boundary. The
keeper uses `KEEPER_DRY_RUN=1` by default and persists its cure timestamps and
event log under `.state/`.

Stress requests alter only values used for simulation. A price shock changes
collateral price to `price * (1 + gpuPriceShockPct / 100)`. Utilization changes
to `utilization * clamp(1 + utilizationShockPct / 100, 0, 2)`.
`shockedPD = min(1, PD * defaultRateMultiplier)` and
`vaultLoss = sum(principal * shockedPD * LGD)`. First-loss cover absorbs
`min(vaultLoss, configuredCover)`. Before-shock APY is annual loan interest
divided by deposits; after-shock APY is
`max(0, beforeAPY * utilizationFactor - uncoveredLoss / deposits)`. APY is a
modeled lender yield, not an on-ledger yield. The endpoint is disabled outside
`MOCK=1` unless `DEMO_SHOCK_ENABLED=1` is explicitly set.

## Simulator and stretch endpoints

The book simulator creates the configured number of borrowers, distributes
them across grades, and samples deterministic 30-day outcomes using the fixed
seed. A borrower defaults when its draw is below grade PD; otherwise a margin
call occurs with probability `min(0.75, 0.05 + 0.8 * PD)`. A called borrower
cures with probability `max(0.05, 0.8 - 2 * PD)`; a noncalled loan is late
when its draw is below `PD / 2`. The rate curve uses representative scores
A=90, B=80, C=65, D=50, E=25 and `APR = baseAPR + ((100 - score) / 100) *
0.06 + max(0, LTV - baseMaxLTV) * 0.10`. Vault utilization is
outstanding modeled principal divided by configured vault deposits. Weighted
APR is the sum of principal times APR divided by outstanding principal.
Expected loss uses each loan's PD and the same 10 percent collateral recovery
haircut as loan quotes. Cover ratio is configured cover divided by expected
loss; it is `UNBOUNDED` when expected loss is zero. These portfolio summaries
are simulated until live vault fields are added to the API contract.


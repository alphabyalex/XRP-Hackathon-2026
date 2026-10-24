# services/credit

Owner: Lucy. Python 3.11+, FastAPI, port 7100.

Moonshift lends against fractional GPU shares. This service reads a borrower's
on-chain XRPL history through Quicknode and turns it into a credit profile:
a 0 to 100 score, an A to E grade, a confidence level, and for every number
the transactions behind it. The api passes the profile to risk, which sets
loan terms. It also watches borrowers live through Quicknode Streams.

How Quicknode is used, and why: [docs/QUICKNODE.md](../../docs/QUICKNODE.md).
Contracts: [contracts/credit/](../../contracts/credit/). Progress:
[docs/status/lucy.md](../../docs/status/lucy.md).

## Run

```
cd services/credit
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
MOCK=0 uvicorn credit.main:app --port 7100
```

`MOCK=1` is the default and returns the contract examples exactly, labeled
`simulated: true`, so other services can build against it with no network.

Try it (public endpoints work with no keys; responses say `source: "public"`):

```
curl localhost:7100/health
curl localhost:7100/profile/testnet/rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb
curl localhost:7100/profile/mainnet/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh
curl localhost:7100/explain/testnet/rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb
curl -N localhost:7100/events
```

## Test and type check

```
pytest          # 70+ tests, no network needed (fake rippled; the JS filter runs in Node if installed)
mypy
ruff check .
```

## Environment

Read from the process env, then `services/credit/.env`, then the repo root
`.env`. Template: [.env.example](.env.example). Never commit real values.

| Var | Default | Purpose |
|---|---|---|
| `MOCK` | `1` | `1` returns contract examples, `0` reads the ledger |
| `PORT` | `7100` | |
| `INTERNAL_API_KEY` | empty | Required `X-MS-Internal-Key` on internal routes when set; sent to api and risk |
| `QUICKNODE_XRPL_MAINNET_URL` | empty | Quicknode HTTPS endpoint. Unset: public `xrplcluster.com`, `source: "public"` |
| `QUICKNODE_XRPL_TESTNET_URL` | empty | Same for testnet. Unset: public altnet |
| `QUICKNODE_XRPL_DEVNET_URL` | empty | Only if the dashboard offers XRPL Devnet. Unset: public devnet |
| `MONITOR_MODE` | `streams` | `streams` (Quicknode Streams webhook), `websocket` (fallback), `off` |
| `STREAMS_NETWORK` | `testnet` | Network the Stream reads, when a delivery does not say |
| `QUICKNODE_STREAMS_TOKEN` | empty | Stream security token, verifies `X-QN-Signature` |
| `QUICKNODE_API_KEY` | empty | Keeps the Quicknode Key-Value Store watchlist in sync |
| `QUICKNODE_KV_LIST` | `moonshift-borrowers` | Watchlist name, must match the filter |
| `STREAMS_ALLOW_UNSIGNED` | `0` | Local testing only |
| `API_URL` | `http://localhost:4000` | Where credit events are POSTed |
| `RISK_URL` | `http://localhost:7000` | `GET /book/stats` for portfolio context |
| `ACCOUNT_TX_MAX_PAGES` | `10` | History depth, 200 txs per page |
| `CACHE_TTL_SECONDS` | `900` | Raw response cache for latest data |
| `CREDIT_DB_PATH` | `data/credit.db` | SQLite cache, watchlist, link proofs (gitignored) |

## Endpoints

| Method and path | What |
|---|---|
| `GET /health` | Mock flag, whether Quicknode is configured per network (booleans only), monitor mode |
| `GET /profile/{network}/{address}` | Credit profile. `?refresh=1` skips the cache |
| `POST /profiles` | Batch, up to 20 |
| `GET /explain/{network}/{address}` | Top three positive and negative factors with tx hashes |
| `POST /link/challenge`, `POST /link/verify` | Prove control of a mainnet address (signed message, no tx) |
| `GET /links/{borrower}` | Verified mainnet addresses of a borrower |
| `POST /watch`, `DELETE /watch/{network}/{address}`, `GET /watch` | Live monitoring watchlist |
| `POST /streams/xrpl` | Quicknode Streams webhook destination (HMAC signed) |
| `POST /monitor/simulate` | Rehearsal event, labeled simulated |
| `GET /events` | Server-sent events: `profile`, `credit_event` |

Every internal route requires `X-MS-Internal-Key` when `INTERNAL_API_KEY` is set.

## The scorecard

A classic bank-style points card, fully transparent. Weights live in
[scorecard.json](scorecard.json), not in code.

1. Start at 50 points.
2. For each feature, add the points of the highest band whose minimum is at
   or below the value. A feature with no data scores its "no data" band.
3. Clamp to 0..100. Grade: A 80+, B 65+, C 50+, D 35+, E below 35.
4. Thin file (fewer than 20 transactions or younger than 90 days):
   confidence `low`, score capped at 60, reason `THIN_FILE`. We would rather
   say "we don't know" than show a fake high score.
5. Confidence `high` needs 100+ transactions and 365+ days; otherwise `medium`.

| Feature | Measures | Bands (value: points) |
|---|---|---|
| `accountAgeDays` | Account age in days | 0+: -10, 30+: -5, 90+: +0, 365+: +6, 1095+: +10 |
| `txCount` | Transactions on record (newest 2,000 max) | 0+: -8, 10+: -3, 50+: +2, 200+: +5, 1000+: +8 |
| `paymentVolumeInXrp` | XRP received in payments | 0+: -3, 100+: +0, 1000+: +3, 10000+: +5 |
| `paymentVolumeOutXrp` | XRP sent in payments | 0+: +0, 100+: +1, 1000+: +2, 10000+: +3 |
| `distinctCounterparties` | Distinct payment counterparties | 0+: -5, 3+: +0, 10+: +3, 50+: +6 |
| `trustlines` | Trustlines held | 0+: +0, 1+: +2, 3+: +3 |
| `balanceStability` | XRP balance stability, 1 / (1 + coefficient of variation) | 0+: -5, 0.3+: +0, 0.6+: +3, 0.8+: +6, no data: +0 |
| `largestOutflowRatio` | Largest XRP payment sent / balance just before it | 0+: +4, 0.25+: +0, 0.5+: -4, 0.9+: -8, no data: +0 |
| `msRepaysOnTime` | Moonshift loans repaid on time (MS_REPAY before due) | 0+: +0, 1+: +5, 3+: +10, 10+: +14 |
| `msRepaysLate` | Moonshift loans repaid late or overdue unpaid | 0+: +0, 1+: -8, 2+: -14, 4+: -20 |
| `msMarginCalls` | Moonshift margin calls received (MS_MARGIN_CALL) | 0+: +0, 1+: -4, 3+: -8 |
| `msLiquidations` | Moonshift collateral escrows claimed by the lender | 0+: +0, 1+: -20, 2+: -35 |
| `msDividendsReceived` | Moonshift GPU dividends received (MS_DIVIDEND) | 0+: +0, 1+: +2, 5+: +4 |
| `msShareTrades` | Moonshift GPU share and contract token trades (OfferCreate) | 0+: +0, 1+: +1, 5+: +2 |

Each feature in a profile carries `value`, `points`, `reason` (a short code)
and `txHashes` (the transactions behind it, up to three for volumes), so a
judge can click through to the explorer and check every point.

### How Moonshift loan history is read

From the transactions `packages/xrpl` writes:

- Loan: the borrower's `EscrowCreate` of GPU shares to `LENDING_POOL`, plus a
  Payment to the borrower with memo `MS_LOAN_DISBURSE {loanId}` (loanId is
  the escrow tx hash). Due time is the escrow's `CancelAfter` minus 120 s.
- On time or late: the borrower's Payment with memo `MS_REPAY {loanId}`,
  compared with the due time. Past due with no repayment counts as late.
- Margin call: a Payment to the borrower with memo `MS_MARGIN_CALL`.
- Liquidation: an `EscrowFinish` of the borrower's collateral escrow by the
  lender.
- Dividends: Payments to the borrower with memo `MS_DIVIDEND` (GPU revenue
  paid to shareholders). Share trades: the borrower's `OfferCreate` on GPA,
  GPB, HRA or HRB.
- Older testnet loans use the pre-rename `GB_` memo names; they are read as
  their `MS_` equivalents.

## Safety

- Read-only. The XRPL client only allows read methods (`account_info`,
  `account_lines`, `account_tx`, `ledger`, `server_info`); there is no submit
  path, so it cannot send a transaction on any network.
- Quicknode URLs hold a token: never logged (httpx and websockets loggers are
  silenced), never returned (health shows booleans), never in error messages.
- Mainnet profiles are always `readOnly: true`.
- Anything not from the ledger is labeled: mock profiles `simulated: true`,
  portfolio default rates "(simulated)", rehearsal events `via: "simulated"`.

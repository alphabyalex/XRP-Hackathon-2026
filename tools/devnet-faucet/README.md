# Devnet refill

Run `py tools/devnet-faucet/fund.py` from the repo. Uses Python's standard
library and only public addresses in `contracts/accounts.devnet.json`.
`--address r...` selects one extra address instead. `MIN_XRP` (100) and
`TARGET_XRP` (300), or `--min-xrp` and `--target-xrp`, control refill thresholds.
Only accounts below the minimum are topped up to the target. Calls pause five
seconds by default; 429 and server failures use bounded exponential backoff.
Only a Markdown balance table is printed. A nonzero exit means a row failed.
Endpoints are fixed to Devnet. No wallet generation or credentials are used.

Request verified against [XRPL's destination refill example](https://xrpl.org/blog/2023/upcoming-devnet-reset).
The [official xrpl.js implementation](https://github.com/XRPLF/xrpl.js/blob/main/packages/xrpl/src/Wallet/fundWallet.ts)
reads `account.classicAddress` from the JSON response, then polls the ledger.
The faucet JSON response is not a ledger confirmation and its balance can be
absent for refills. The tool discards it and verifies `account_info` on the
validated ledger, converting `Balance` from drops to XRP.

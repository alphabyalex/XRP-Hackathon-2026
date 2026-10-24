# Quicknode in Moonshift

Owner: Lucy. Service: `services/credit` (port 7100).

Moonshift underwrites loans against fractional GPU shares. The GPU's revenue
history tells us what the collateral earns. The borrower's own on-chain history,
read through Quicknode, tells us how the borrower behaves with money. This file
records what we verified about Quicknode's XRPL support and exactly how we use it.

## 1. What we verified (Phase 0, checked 2026-10-24)

| Question | Answer | Source |
|---|---|---|
| XRPL networks on Quicknode | Mainnet and Testnet. Devnet is not offered. | [chains/xrpl](https://www.quicknode.com/chains/xrpl), [docs/xrpl/api-overview](https://www.quicknode.com/docs/xrpl/api-overview) |
| Transports | HTTP JSON-RPC and WebSocket (WSS) on both networks | [docs/xrpl/api-overview](https://www.quicknode.com/docs/xrpl/api-overview) |
| History depth | Mainnet is a full archive from ledger 32570 (genesis of the current history), no pruning. Testnet has full history since its last reset. | [chains/xrpl](https://www.quicknode.com/chains/xrpl) |
| Methods we need | `account_info`, `account_lines`, `account_tx` (paged with `marker`), `ledger`, `subscribe` are standard rippled methods and are documented by Quicknode | [docs/xrpl/account_tx](https://www.quicknode.com/docs/xrpl/account_tx), [docs/xrpl/account_info](https://www.quicknode.com/docs/xrpl/account_info) |
| Credit cost | XRP Ledger is in the 40 API credits per call tier (all standard methods) | [api-credits/xrp](https://www.quicknode.com/api-credits/xrp) |
| Free plan | Free trial: 10M API credits (about 250,000 XRPL calls at 40 credits), 15 requests per second, 1 month | [pricing](https://www.quicknode.com/pricing.md) |
| Streams on XRPL | Supported, but only the Block (ledger) dataset on Mainnet and Testnet. No per-transaction or per-account dataset, so address filtering must be done in a Streams filter function. | [docs/streams/supported-chains](https://www.quicknode.com/docs/streams/supported-chains) |
| Webhooks on XRPL | The API overview lists Webhooks as supported for XRPL. The Webhooks docs only name Ethereum and Solana templates. | [docs/xrpl/api-overview](https://www.quicknode.com/docs/xrpl/api-overview), [docs/webhooks/getting-started](https://www.quicknode.com/docs/webhooks/getting-started) |
| Streams/Webhooks on our plan | Unclear. The pricing page lists 1 Stream and 1 Webhook on the free trial; the XRPL chain page FAQ says "Paid plans ... add Streams and Webhooks". | both pages above |

What the docs did not answer: a per-network method whitelist, and whether the
XRPL backend is rippled or Clio (matters only for the Clio-only `tx_type` filter
on `account_tx`, which we do not use).

## 2. Decisions that follow from this

- **Lending writes go to public devnet.** XLS-65/66 only run on devnet and
  Quicknode does not offer devnet. The credit service never writes to any
  ledger at all; it only reads.
- **Quicknode reads borrower history on Mainnet (read-only) and Testnet.**
  Devnet reads use the public devnet endpoint and are labeled `source: "public"`.
- **Live monitoring uses Quicknode Streams first, with a WebSocket fallback.**
  Streams gives guaranteed delivery with retries, and it is a Quicknode product
  rather than a generic node feature. On XRPL it only offers the whole-ledger
  dataset, so a Streams filter function picks out borrower transactions. The
  filter reads the borrower watchlist from the Quicknode Key-Value Store, which
  the credit service keeps up to date. If Streams is not on our plan, or no
  public receiver URL is available, `MONITOR_MODE=websocket` switches to a
  Quicknode WebSocket `subscribe` on `accounts`. Both paths feed the same event
  classifier. See section 4.
- **Stay under 15 rps and the credit budget.** Every raw response is cached in
  SQLite, so repeat demo calls cost zero credits. Rate limit errors (HTTP 429,
  or rippled `slowDown`) are retried with exponential backoff.

Observed on 2026-10-24 while building: the public mainnet server answered a
burst of paged `account_tx` calls (2,000 transactions of history) with
`tooBusy` and `slowDown`, and the fetch failed until we paced it to one call
per second. Deep history is exactly what underwriting needs, which is why the
scorer reads it through a dedicated Quicknode endpoint (15 rps on the free
plan, full archive) rather than shared public servers.

## 3. Configuration

Endpoints come only from environment variables. They contain an auth token, so
they are never printed, logged, returned in an API response or committed.

| Env var | Meaning | Fallback when unset |
|---|---|---|
| `QUICKNODE_XRPL_MAINNET_URL` | Quicknode HTTPS endpoint, XRPL Mainnet | `https://xrplcluster.com/` (public) |
| `QUICKNODE_XRPL_TESTNET_URL` | Quicknode HTTPS endpoint, XRPL Testnet | `https://s.altnet.rippletest.net:51234/` (public) |
| (none, devnet) | Quicknode has no devnet | `https://s.devnet.rippletest.net:51234/` (public) |

The WebSocket URL is derived from the HTTPS URL (`https://` to `wss://`), which
is how Quicknode issues them.

Every profile carries `source: "quicknode"` or `source: "public"` so anyone can
see where the data came from. `GET /health` reports, per network, whether a
Quicknode endpoint is configured (a boolean, never the URL).

## 4. Live monitoring (Phase 5)

Further verified facts for the Streams design:

| Question | Answer | Source |
|---|---|---|
| XRPL ledger payload | `data` is an array of ledgers shaped like the `ledger` RPC result: `ledger_index`, `ledger.close_time_iso`, and `ledger.transactions[]` expanded with `hash` and `metaData` | [docs/streams/data-sources/xrpl](https://www.quicknode.com/docs/streams/data-sources/xrpl) |
| Filter functions | JavaScript `main(stream)`, `async` when using `qnLib`; return `null` to skip delivery | [docs/streams/filters](https://www.quicknode.com/docs/streams/filters) |
| Watchlist in a filter | `await qnLib.qnContainsListItems(listId, items)` returns `boolean[]`, free inside filters | [docs/streams/filters/key-value-store](https://www.quicknode.com/docs/streams/filters/key-value-store) |
| Updating the watchlist | Key-Value Store REST `https://api.quicknode.com/kv/rest/v1/lists`, header `x-api-key`, `POST /lists` to create, `POST /lists/{key}/items` to add | [KV REST OpenAPI](https://api.quicknode.com/kv/rest/openapi.json) |
| Webhook signature | Headers `X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`; HMAC-SHA256 with the stream's security token over `nonce + timestamp + payload`, hex digest | [validating Streams webhook messages](https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages) |
| Delivery | POST JSON, optional gzip, any non-2xx is retried, stream pauses after 3 failed retries by default | [docs/streams/destinations/webhooks](https://www.quicknode.com/docs/streams/destinations/webhooks) |

### How it is wired

```
Quicknode Stream (XRP Ledger, dataset: Ledger, network: STREAMS_NETWORK)
  -> filter services/credit/quicknode/streams_filter.js
       reads every tx in each ledger, keeps those whose Account, Destination
       or Owner is in the Key-Value Store list "moonshift-borrowers"
  -> webhook POST <public credit URL>/streams/xrpl   (signed, X-QN-Signature)
  -> services/credit verifies the HMAC, classifies each tx, emits credit events
       -> GET /events (SSE) and api POST /internal/credit-events
```

- **Watchlist.** `POST /watch {network, address, loans?}` adds a borrower.
  The credit service adds the address to the Quicknode KV list (REST, needs
  `QUICKNODE_API_KEY`), so the Stream's filter starts matching it with no
  redeploy. It also loads the borrower's open Moonshift loans from history so
  it can raise MISSED_PAYMENT.
- **Events.** LARGE_OUTFLOW (one payment of at least 50% of the balance
  before it), MS_LOAN_DISBURSE, MS_REPAY, MARGIN_CALL (memo MS_MARGIN_CALL),
  LIQUIDATION (lender finishes the collateral escrow), and MISSED_PAYMENT
  (a loan passes its due time with no MS_REPAY; checked every 15 s). Event ids
  are derived from kind, network, address and tx hash, so a Streams retry
  never produces a duplicate.
- **Security.** Deliveries without a valid `X-QN-Signature` get 401, unless
  `STREAMS_ALLOW_UNSIGNED=1` (local testing only).
- **Fallback.** `MONITOR_MODE=websocket` subscribes to the watched accounts
  over the Quicknode WSS endpoint (public WSS if unset), reconnecting with
  backoff and resubscribing when the watchlist changes. Same classifier.
- **Demo helper.** `POST /monitor/simulate` emits an event labeled
  `simulated: true, via: "simulated"` for rehearsals.

### Which network the Stream reads

Moonshift's XLS-65/66 lending runs on devnet, and Quicknode's docs list only
Mainnet and Testnet for XRPL (Streams included). The receiver is network
agnostic: it takes the network from the delivery's metadata, else
`STREAMS_NETWORK`.

- If the Quicknode dashboard offers an XRPL Devnet endpoint and Stream, set
  `STREAMS_NETWORK=devnet` and `QUICKNODE_XRPL_DEVNET_URL`. Nothing else changes.
- Otherwise run the Stream on Testnet. The current packages/xrpl loan flow
  (escrowed shares, MS_REPAY memos) already runs on testnet, so repayments,
  margin calls and liquidations there are caught live by Quicknode Streams.

### Setting up the Stream (about 5 minutes, done by a human)

1. Set `QUICKNODE_API_KEY` (Quicknode dashboard, API keys) and start the
   credit service. `POST /watch` creates the `moonshift-borrowers` list on
   first use.
2. Dashboard, Streams, Create Stream: chain XRP Ledger, network Testnet (or
   Devnet if offered), dataset Ledger, start from latest.
3. Filter: paste `services/credit/quicknode/streams_filter.js`. Use the test
   button on a recent ledger after watching an active address.
4. Destination: Webhook, URL `https://<public host>/streams/xrpl`. The credit
   service must be reachable from the internet (deploy next to compute on EC2,
   or a tunnel such as `ngrok http 7100` for a laptop demo).
5. Copy the Stream's security token into `QUICKNODE_STREAMS_TOKEN` and
   restart the credit service. `GET /health` shows `streamsTokenSet: true`.

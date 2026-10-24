// Moonshift credit: Quicknode Streams filter for the XRP Ledger "ledger" dataset.
//
// Paste into the Stream's filter editor (Streams > your stream > Filter). Each delivery is a batch
// of ledgers with expanded transactions (hash + metaData). We keep only transactions that touch a
// watched borrower, using the Quicknode Key-Value Store list that services/credit keeps in sync
// (POST /watch adds addresses). Returning null skips the delivery.
//
// Delivered body: { network, matches: [{ ledgerIndex, closeTimeIso, addresses, tx }] }
// Receiver: services/credit POST /streams/xrpl (see contracts/credit/streams_webhook.json).

const WATCHLIST = 'moonshift-borrowers' // must match QUICKNODE_KV_LIST in services/credit

function touched(tx) {
  // Account sends, Destination receives, Owner is the escrow owner on EscrowFinish/Cancel.
  return [...new Set([tx.Account, tx.Destination, tx.Owner].filter((a) => typeof a === 'string'))]
}

async function main(stream) {
  const items = Array.isArray(stream.data) ? stream.data : [stream.data]
  const candidates = []
  for (const item of items) {
    if (!item) continue
    const ledger = item.ledger || item
    for (const tx of ledger.transactions || []) {
      if (!tx || typeof tx !== 'object') continue // hash-only ledgers carry strings
      candidates.push({
        ledgerIndex: Number(item.ledger_index || ledger.ledger_index),
        closeTimeIso: ledger.close_time_iso || null,
        addresses: touched(tx),
        tx,
      })
    }
  }

  const unique = [...new Set(candidates.flatMap((c) => c.addresses))]
  if (unique.length === 0) return null

  // One batched lookup, index-aligned with `unique`. Free inside filters.
  const flags = await qnLib.qnContainsListItems(WATCHLIST, unique)
  const watched = new Set(unique.filter((_, i) => flags[i]))

  const matches = candidates
    .filter((c) => c.addresses.some((a) => watched.has(a)))
    .map((c) => ({ ...c, addresses: c.addresses.filter((a) => watched.has(a)) }))

  if (matches.length === 0) return null
  const network = (stream.metadata && stream.metadata.network) || null
  return { network, matches }
}

// Lets the repo's tests load this file in Node. Quicknode ignores it.
if (typeof module !== 'undefined') module.exports = { main }

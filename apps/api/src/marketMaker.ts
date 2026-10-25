// Market making for the GPU share books, so each book is two-sided around the GPU's one share
// price (sharePrice.ts reference, which moves only with payouts): the GPU's treasury offers its
// shares 1.5% above it and CAROL (a system account, not a user) keeps a resting bid 1.5% below.
// Real devnet offers; a 1-share buy fills against the treasury's ask. Quoting no longer follows
// NAV, whose treasury cash grows with every share the treasury sells (that made the price climb).

import { GPUS, fix6, treasuryOf, type GpuId } from "@moonshift/shared";
import * as xrpl from "./adapters/xrplAdapter.js";
import { logTx } from "./db/helpers.js";
import { priceMoved, referencePrice, sharePrice } from "./sharePrice.js";
import * as lending from "./adapters/lendingAdapter.js";
import { recordOracle, stressActive } from "./lending/service.js";

// The on-ledger oracle (the loans' collateral price) tracks the market price,
// so /borrow shows the same share price as the market, GPU and portfolio pages.
const ORACLE_TOLERANCE = 0.0025;

export async function syncOracle(gpuId: GpuId): Promise<string | null> {
  if (stressActive(gpuId)) return null; // a stress test holds the crash price until Restore
  const [market, oracle] = await Promise.all([sharePrice(gpuId), lending.oraclePrice(gpuId)]);
  if (!(Number(market.price) > 0) || Math.abs(Number(market.price) / Number(oracle.price) - 1) <= ORACLE_TOLERANCE) return null;
  const tx = await lending.publishPrice(gpuId, market.price);
  recordOracle(gpuId, market.price, "market", tx.hash);
  logTx(tx, "oracle.market", "ORACLE", `${gpuId} price ${market.price} USDC (market)`);
  return tx.hash;
}

const SPREAD = 0.015;
const BID_SHARES = "100";
// Most of the treasury's shares stay off the book; this many are offered at a time.
const ASK_SHARES = 200;

let running: Promise<Record<string, unknown>> | null = null;

export function quoteMarket(): Promise<Record<string, unknown>> {
  if (running) return running;
  running = (async () => {
    const out: Record<string, unknown> = {};
    for (const g of GPUS) {
      try {
        const ref = Number(await referencePrice(g.id));
        if (!(ref > 0)) continue;
        // The treasury sells while it holds shares; once it is down to less than a few, CAROL (which
        // bought every share its bids filled) offers from what it holds, so a buy always fills.
        const treasuryHeld = Number((await xrpl.getBalances(treasuryOf(g.id))).tokens[g.shareCode] ?? "0");
        const seller = treasuryHeld >= 5 ? treasuryOf(g.id) : "CAROL";
        const held = seller === "CAROL" ? Number((await xrpl.getBalances("CAROL")).tokens[g.shareCode] ?? "0") : treasuryHeld;
        const askQty = String(Math.floor(Math.min(held, ASK_SHARES)));
        const askPx = ref * (1 + SPREAD);
        const quoteAsk = () => xrpl.requoteShareOffer({ account: seller, gpuId: g.id, side: "ask", price: fix6(askPx), qty: askQty });
        const quoteBid = () => xrpl.requoteShareOffer({ account: "CAROL", gpuId: g.id, side: "bid", price: fix6(ref * (1 - SPREAD)), qty: BID_SHARES });
        // The market maker never trades with itself: when the new ask would reach the standing bid
        // (NAV fell), move CAROL's bid down first; otherwise move the ask first.
        const book = await xrpl.getShareBook(g.id);
        const bidFirst = book.bestBid !== null && askPx <= Number(book.bestBid);
        let ask: Awaited<ReturnType<typeof quoteAsk>>;
        let bid: Awaited<ReturnType<typeof quoteBid>>;
        if (bidFirst) {
          bid = await quoteBid();
          ask = await quoteAsk();
        } else {
          ask = await quoteAsk();
          bid = await quoteBid();
        }
        for (const [who, r] of [[seller, ask], ["CAROL", bid]] as const) {
          for (const hash of r.hashes) {
            logTx({ hash, result: "tesSUCCESS", validated: true, explorerUrl: "" }, "marketMaker", who, `${who} quotes ${g.id} shares at ${r.price} USDC`);
          }
        }
        out[g.id] = { reference: fix6(ref), ask: ask.action === "skipped" ? null : ask.price, bid: bid.price, actions: [ask.action, bid.action] };
      } catch (e) {
        out[g.id] = { error: (e as Error).message };
      } finally {
        priceMoved(g.id);
      }
      try {
        const hash = await syncOracle(g.id);
        if (hash && out[g.id] && typeof out[g.id] === "object") (out[g.id] as Record<string, unknown>).oracle = hash;
      } catch {
        // the oracle catches up on the next run
      }
    }
    return out;
  })().finally(() => {
    running = null;
  });
  return running;
}

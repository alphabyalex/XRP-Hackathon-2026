// Market making for the GPU share books, so each book is two-sided and its
// midpoint reflects the GPU: the GPU's treasury offers its shares at NAV (from
// its real treasury cash and utilization, via pricing), and CAROL (a system
// account, not a user) keeps a resting bid 3% below. Both are re-quoted when
// NAV moves more than 1%. Real devnet offers; users trade against them, and
// any offer a user posts inside the spread moves the midpoint.

import { GPUS, fix6, treasuryOf, type GpuId } from "@moonshift/shared";
import * as xrpl from "./adapters/xrplAdapter.js";
import * as pricing from "./adapters/pricingClient.js";
import { logTx } from "./db/helpers.js";
import { priceMoved, sharePrice } from "./sharePrice.js";
import * as lending from "./adapters/lendingAdapter.js";
import { recordOracle } from "./lending/service.js";

// The on-ledger oracle (the loans' collateral price) tracks the market price,
// so /borrow shows the same share price as the market, GPU and portfolio pages.
const ORACLE_TOLERANCE = 0.0025;

export async function syncOracle(gpuId: GpuId): Promise<string | null> {
  const [market, oracle] = await Promise.all([sharePrice(gpuId), lending.oraclePrice(gpuId)]);
  if (!(Number(market.price) > 0) || Math.abs(Number(market.price) / Number(oracle.price) - 1) <= ORACLE_TOLERANCE) return null;
  const tx = await lending.publishPrice(gpuId, market.price);
  recordOracle(gpuId, market.price, "market", tx.hash);
  logTx(tx, "oracle.market", "ORACLE", `${gpuId} price ${market.price} USDC (market)`);
  return tx.hash;
}

const BID_DISCOUNT = 0.03;
const BID_SHARES = "100";

let running: Promise<Record<string, unknown>> | null = null;

export function quoteMarket(): Promise<Record<string, unknown>> {
  if (running) return running;
  running = (async () => {
    const out: Record<string, unknown> = {};
    for (const g of GPUS) {
      try {
        const nav = Number((await pricing.getNav(g.id)).nav_per_share);
        if (!(nav > 0)) continue;
        const held = (await xrpl.getBalances(treasuryOf(g.id))).tokens[g.shareCode] ?? "0";
        const ask = await xrpl.requoteShareOffer({ account: treasuryOf(g.id), gpuId: g.id, side: "ask", price: fix6(nav), qty: held });
        const bid = await xrpl.requoteShareOffer({ account: "CAROL", gpuId: g.id, side: "bid", price: fix6(nav * (1 - BID_DISCOUNT)), qty: BID_SHARES });
        for (const [who, r] of [[treasuryOf(g.id), ask], ["CAROL", bid]] as const) {
          for (const hash of r.hashes) {
            logTx({ hash, result: "tesSUCCESS", validated: true, explorerUrl: "" }, "marketMaker", who, `${who} quotes ${g.id} shares at ${r.price} USDC`);
          }
        }
        out[g.id] = { nav: fix6(nav), ask: ask.action === "skipped" ? null : ask.price, bid: bid.price, actions: [ask.action, bid.action] };
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

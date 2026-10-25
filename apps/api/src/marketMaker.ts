// Market making for the GPU share books, so each book is two-sided and its
// midpoint reflects the GPU: the GPU's treasury offers its shares at NAV (from
// its real treasury cash and utilization, via pricing), and CAROL (a system
// account, not a user) keeps a resting bid 3% below. Both are re-quoted when
// NAV moves more than 1%. Real devnet offers; users trade against them, and
// any offer a user posts inside the spread moves the midpoint.

import { GPUS, fix6, type GpuId } from "@moonshift/shared";
import * as xrpl from "./adapters/xrplAdapter.js";
import * as pricing from "./adapters/pricingClient.js";
import { logTx } from "./db/helpers.js";
import { priceMoved } from "./sharePrice.js";

const BID_DISCOUNT = 0.03;
const BID_SHARES = "100";
const TREASURY: Record<GpuId, "TREASURY_GPU_A" | "TREASURY_GPU_B"> = { "gpu-a": "TREASURY_GPU_A", "gpu-b": "TREASURY_GPU_B" };

let running: Promise<Record<string, unknown>> | null = null;

export function quoteMarket(): Promise<Record<string, unknown>> {
  if (running) return running;
  running = (async () => {
    const out: Record<string, unknown> = {};
    for (const g of GPUS) {
      try {
        const nav = Number((await pricing.getNav(g.id)).nav_per_share);
        if (!(nav > 0)) continue;
        const held = (await xrpl.getBalances(TREASURY[g.id])).tokens[g.shareCode] ?? "0";
        const ask = await xrpl.requoteShareOffer({ account: TREASURY[g.id], gpuId: g.id, side: "ask", price: fix6(nav), qty: held });
        const bid = await xrpl.requoteShareOffer({ account: "CAROL", gpuId: g.id, side: "bid", price: fix6(nav * (1 - BID_DISCOUNT)), qty: BID_SHARES });
        for (const [who, r] of [[TREASURY[g.id], ask], ["CAROL", bid]] as const) {
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
    }
    return out;
  })().finally(() => {
    running = null;
  });
  return running;
}

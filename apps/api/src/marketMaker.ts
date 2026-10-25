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
import { liquidityLadder } from "@moonshift/xrpl";
import { broadcast } from "./sse.js";
import { canSignGpuTreasury } from "./treasuryCapabilities.js";

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



let running: Promise<Record<string, unknown>> | null = null;

export function quoteMarket(): Promise<Record<string, unknown>> {
  if (running) return running;
  running = (async () => {
    const out: Record<string, unknown> = {};
    for (const g of GPUS) {
      if (!canSignGpuTreasury(g.id)) {
        out[g.id] = { unavailable: "Treasury signing is not available for this GPU." };
        continue;
      }
      try {
        const ref = Number(await referencePrice(g.id));
        if (!(ref > 0)) continue;
        // The treasury sells while it holds shares; once it is down to less than a few, CAROL (which
        // bought every share its bids filled) offers from what it holds, so a buy always fills.
        const treasuryHeld = Number((await xrpl.getBalances(treasuryOf(g.id))).tokens[g.shareCode] ?? "0");
        const seller = treasuryHeld >= 5 ? treasuryOf(g.id) : "CAROL";
        const held = seller === "CAROL" ? Number((await xrpl.getBalances("CAROL")).tokens[g.shareCode] ?? "0") : treasuryHeld;
        const cash = Number((await xrpl.getBalances("CAROL")).tokens.TDX ?? "0");
        const enabled = GPUS.filter(gpu => canSignGpuTreasury(gpu.id)).length;
        const ladder = liquidityLadder(ref, held, cash / Math.max(1, enabled));
        const quoteAsk = () => xrpl.requoteShareLadder({account:seller,gpuId:g.id,side:"ask",levels:ladder.asks});
        const quoteBid = () => xrpl.requoteShareLadder({account:"CAROL",gpuId:g.id,side:"bid",levels:ladder.bids});
        const book = await xrpl.getShareBook(g.id);
        // Move bids first if a new ask could cross the old bid. Protocol orders
        // remain passive and never cross their opposite protocol ladder.
        const bidFirst = book.bestBid !== null && ladder.asks.length > 0 && Number(ladder.asks[0].price) <= Number(book.bestBid);
        let ask: Awaited<ReturnType<typeof quoteAsk>>, bid: Awaited<ReturnType<typeof quoteBid>>;
        if (bidFirst) { bid=await quoteBid(); ask=await quoteAsk(); }
        else { ask=await quoteAsk(); bid=await quoteBid(); }
        for (const [who,r] of [[seller,ask],["CAROL",bid]] as const) {
          for(const hash of r.hashes) logTx({hash,result:"tesSUCCESS",validated:true,explorerUrl:""},"marketMaker",who,`${who} quotes ${g.id} share liquidity`);
        }
        out[g.id] = {reference:fix6(ref),ask:ladder.asks[0]?.price??null,bid:ladder.bids[0]?.price??null,askLevels:ladder.asks.length,bidLevels:ladder.bids.length,actions:[ask.action,bid.action]};
        if(ask.hashes.length || bid.hashes.length) broadcast("market", {gpuId:g.id,source:"ledger",askLevels:ladder.asks.length,bidLevels:ladder.bids.length});
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

// GET /gpus/:id/stats (contracts/api/gpu_stats.json): one GPU's market and earnings in one place,
// so Home, Market, the GPU page and Portfolio show the same numbers.
//   price, open, change: sharePrice.ts (the one share price)
//   high, low, volume:   real DEX fills (share_trades) and recorded price ticks, last 24 h only
//   book:                funded offers on the XRPL DEX
//   payouts:             the dividend ledger (dividend_runs, payouts); revenue: the metered revenue ledger
//   working:             the GPU's own schedule (compute calendar plus the api's records), last 20 h

import { GPUS, fix6, networkInfo, type GpuId } from "@moonshift/shared";
import { db } from "./db/db.js";
import * as xrpl from "./adapters/xrplAdapter.js";
import * as compute from "./adapters/computeClient.js";
import * as pricing from "./adapters/pricingClient.js";
import { historyCalendar } from "./marketHistory.js";
import { change24hPct, openPrice, priceWindowStart, resetAt, sharePrice } from "./sharePrice.js";

const HOUR = 3600e3;
const num = (v: unknown) => Number(v ?? 0);

// Share of the last `hours` covered by work on the GPU's schedule, as a percent.
async function workingPct(gpuId: GpuId, hours: number): Promise<string> {
  const now = Date.now();
  const from = now - hours * HOUR;
  const iso = (t: number) => new Date(t).toISOString();
  const live = await compute.getCalendar(gpuId, iso(from), iso(now)).catch(() => []);
  const spans = [...live, ...historyCalendar(gpuId, iso(from), iso(now))]
    .map((e) => [Math.max(from, Date.parse(e.start)), Math.min(now, Date.parse(e.end))] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let end = from;
  for (const [a, b] of spans) {
    const start = Math.max(a, end);
    if (b > start) busy += b - start;
    end = Math.max(end, b);
  }
  return ((busy / (hours * HOUR)) * 100).toFixed(1);
}

// Paid per share in the last 24 h (the dividend ledger) and the yield it implies at `price`.
// /gpus, the stats route and the portfolio all use this, so every yield on the site agrees.
export function payoutYield(gpuId: GpuId, price: string | number): { paidPerShare24h: string; yieldPct: string | null } {
  const since = new Date(Date.now() - 24 * HOUR).toISOString();
  const row = db
    .prepare(`SELECT COALESCE(SUM(CAST(per_share AS REAL)), 0) AS perShare FROM dividend_runs WHERE gpu_id = ? AND status = 'paid' AND created_at >= ?`)
    .get(gpuId, since) as { perShare: number };
  const p = Number(price);
  return { paidPerShare24h: row.perShare.toFixed(6), yieldPct: p > 0 ? ((row.perShare * 365) / p * 100).toFixed(2) : null };
}

export async function gpuStats(gpuId: GpuId) {
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  // Fills, ticks and volume start at the later of 24 h ago and the last price reset.
  const reset = resetAt(gpuId);
  const day0 = new Date(Date.now() - 24 * HOUR).toISOString();
  const since = reset && reset > day0 ? reset : day0;
  const explorer = networkInfo().explorer;
  const [market, nav, holders, depth, working] = await Promise.all([
    sharePrice(gpuId),
    pricing.getNav(gpuId),
    xrpl.getHolders(gpuId),
    xrpl.getShareDepth(gpuId).catch(() => ({ bids: [], asks: [] })),
    workingPct(gpuId, 20),
  ]);
  const price = market.price;

  const fills = db.prepare(`SELECT hash, price, qty, side, at FROM share_trades WHERE gpu_id = ? AND at >= ? ORDER BY at DESC LIMIT 100`).all(gpuId, since) as {
    hash: string;
    price: string;
    qty: string;
    side: string;
    at: string;
  }[];
  // Recorded prices for the candles, last 7 days (sharePrice.ts records each one it serves).
  const points = db
    .prepare(`SELECT ts, price FROM share_prices WHERE gpu_id = ? AND ts >= ? ORDER BY ts`)
    .all(gpuId, (() => {
      const week = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
      return reset && reset > week ? reset : week;
    })()) as { ts: string; price: string }[];
  const ticks = [
    ...points.map((p) => ({ t: p.ts, price: fix6(p.price) })),
    ...fills.map((f) => ({ t: f.at, price: fix6(f.price), qty: fix6(f.qty) })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  const windowStart = priceWindowStart(gpuId);
  const day = ticks.filter((t) => t.t >= windowStart).map((t) => Number(t.price));

  // Payouts: paid dividend runs (per share), and what holders actually received in the last run.
  const paid = db
    .prepare(`SELECT COALESCE(SUM(CAST(per_share AS REAL)), 0) AS perShare FROM dividend_runs WHERE gpu_id = ? AND status = 'paid' AND created_at >= ?`)
    .get(gpuId, since) as { perShare: number };
  const last = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(p.amount AS REAL)), 0) AS total FROM payouts p WHERE p.tx_hash IS NOT NULL AND p.dividend_run_id = (
         SELECT id FROM dividend_runs WHERE gpu_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1)`
    )
    .get(gpuId) as { total: number };
  const perShare = paid.perShare;

  return {
    gpuId,
    price,
    openPrice: openPrice(gpuId, price),
    change24hPct: change24hPct(gpuId, price),
    volume24h: fix6(fills.reduce((s, f) => s + num(f.qty), 0)),
    high24h: day.length ? fix6(Math.max(...day)) : null,
    low24h: day.length ? fix6(Math.min(...day)) : null,
    marketCap: fix6(num(price) * gpu.sharesTotal),
    holders: holders.length,
    navPerShare: nav.nav_per_share,
    yieldPct: num(price) > 0 ? ((perShare * 365) / num(price) * 100).toFixed(2) : null,
    paidPerShare24h: perShare.toFixed(6),
    revenue24h: nav.trailing_revenue_24h,
    workingPct20h: working,
    paidToHoldersLastNight: last.total.toFixed(6),
    bids: depth.bids,
    asks: depth.asks,
    trades: fills.map((f) => ({
      t: f.at,
      price: fix6(f.price),
      qty: fix6(f.qty),
      side: f.side === "sell" ? "sell" : "buy",
      hash: f.hash,
      explorerUrl: `${explorer}/transactions/${f.hash}`,
    })),
    ticks,
    updatedAt: new Date().toISOString(),
  };
}

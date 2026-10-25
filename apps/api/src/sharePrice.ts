// GPU share prices from the XRPL DEX: the best bid/ask midpoint, else the
// last trade the api executed, else the on-ledger oracle NAV. The oracle stays
// the collateral price for loans (lending/service.ts); this is the market price.
//
// Every price shown is recorded (at most one point per 5 minutes per GPU unless
// it moved), so the 24 h change and the chart are real, not drawn.

import type { GpuId } from "@moonshift/shared";
import { db } from "./db/db.js";
import * as xrpl from "./adapters/xrplAdapter.js";
import { oraclePrice } from "./adapters/lendingAdapter.js";
import { swr } from "./lending/swr.js";

export interface SharePrice {
  price: string;
  source: "midpoint" | "last trade" | "oracle";
  bestBid: string | null;
  bestAsk: string | null;
  lastTrade: string | null;
}

const POINT_EVERY_MS = 5 * 60_000;
const cache = swr<SharePrice>("share price", 5_000, 60_000);

function lastTrade(gpuId: GpuId): { price: string; at: string } | null {
  return (db.prepare(`SELECT price, at FROM share_trades WHERE gpu_id = ? ORDER BY at DESC LIMIT 1`).get(gpuId) as { price: string; at: string } | undefined) ?? null;
}

function recordPoint(gpuId: GpuId, p: SharePrice): void {
  const last = db.prepare(`SELECT ts, price FROM share_prices WHERE gpu_id = ? ORDER BY ts DESC LIMIT 1`).get(gpuId) as { ts: string; price: string } | undefined;
  const now = Date.now();
  const moved = !last || Math.abs(Number(last.price) - Number(p.price)) > 1e-6;
  if (!last || moved || now - new Date(last.ts).getTime() >= POINT_EVERY_MS) {
    db.prepare(`INSERT OR REPLACE INTO share_prices (gpu_id, ts, price, source) VALUES (?, ?, ?, ?)`).run(gpuId, new Date(now).toISOString(), p.price, p.source);
  }
}

async function readPrice(gpuId: GpuId): Promise<SharePrice> {
  const book = await xrpl.getShareBook(gpuId).catch(() => ({ bestBid: null, bestAsk: null }));
  const trade = lastTrade(gpuId);
  let out: SharePrice;
  if (book.bestBid && book.bestAsk) {
    out = { price: ((Number(book.bestBid) + Number(book.bestAsk)) / 2).toFixed(6), source: "midpoint", ...book, lastTrade: trade?.price ?? null };
  } else if (trade) {
    out = { price: Number(trade.price).toFixed(6), source: "last trade", ...book, lastTrade: trade.price };
  } else {
    out = { price: (await oraclePrice(gpuId)).price, source: "oracle", ...book, lastTrade: null };
  }
  recordPoint(gpuId, out);
  return out;
}

export function sharePrice(gpuId: GpuId): Promise<SharePrice> {
  return cache.get(gpuId, () => readPrice(gpuId));
}

// A trade or a requote changed the book: read the price fresh.
export function priceMoved(gpuId?: GpuId): void {
  cache.invalidate(gpuId);
}

// After a share buy or sell the api executed: the actual fill, from the ledger.
export async function recordTrade(gpuId: GpuId, hash: string, address: string): Promise<void> {
  try {
    const fill = await xrpl.shareFill(hash, address, gpuId);
    if (fill) {
      db.prepare(`INSERT OR IGNORE INTO share_trades (hash, gpu_id, price, qty, side, at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        hash,
        gpuId,
        fill.price,
        fill.qty,
        fill.side,
        new Date().toISOString()
      );
    }
  } catch {
    // the trade stands; it just does not count as the last trade
  }
  priceMoved(gpuId);
}

// Hourly closes for the last `days` days (the chart), oldest first.
export function priceHistory(gpuId: GpuId, days = 7): { t: number; price: number }[] {
  const rows = db
    .prepare(`SELECT ts, price FROM share_prices WHERE gpu_id = ? AND ts >= ? ORDER BY ts`)
    .all(gpuId, new Date(Date.now() - days * 86400e3).toISOString()) as { ts: string; price: string }[];
  const byHour = new Map<number, number>();
  for (const r of rows) byHour.set(Math.floor(new Date(r.ts).getTime() / 3600e3), Number(r.price));
  return [...byHour.entries()].map(([h, price]) => ({ t: h * 3600e3, price }));
}

// Percent change against the price 24 hours ago (or the oldest point since, if newer).
export function change24hPct(gpuId: GpuId, price: string): string {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const before = (db.prepare(`SELECT price FROM share_prices WHERE gpu_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(gpuId, since) ??
    db.prepare(`SELECT price FROM share_prices WHERE gpu_id = ? AND ts > ? ORDER BY ts LIMIT 1`).get(gpuId, since)) as { price: string } | undefined;
  if (!before || !(Number(before.price) > 0)) return "0.00";
  return ((Number(price) / Number(before.price) - 1) * 100).toFixed(2);
}

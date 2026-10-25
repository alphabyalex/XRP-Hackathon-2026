// The one GPU share price. Every route reads it from here: /gpus, /gpus/:id, /gpus/:id/stats,
// portfolio valuation, and (through the on-ledger oracle, which marketMaker.syncOracle keeps equal
// to it) borrow collateral and the max borrow.
//
// It is a stored reference per GPU that moves only when a payout is made (by the amount paid per
// share). The market maker quotes its ask and bid around it, so treasury cash growing from share
// sales, vault deposits or restarts can never push it up. The DEX book and last trade are
// reported beside it.
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
  source: "reference";
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

// Opening reference prices (set by the 2026-10-25 morning reset). A GPU not listed starts at the
// on-ledger oracle price the first time it is read.
const OPENING: Partial<Record<GpuId, string>> = { "gpu-a": "20.000000", "gpu-b": "5.000000" };

export async function referencePrice(gpuId: GpuId): Promise<string> {
  const row = db.prepare(`SELECT price FROM share_reference WHERE gpu_id = ?`).get(gpuId) as { price: string } | undefined;
  if (row) return row.price;
  const start = OPENING[gpuId] ?? (await oraclePrice(gpuId)).price;
  const at = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO share_reference (gpu_id, price, updated_at, reason, reset_at) VALUES (?, ?, ?, ?, ?)`).run(gpuId, start, at, "opening", at);
  return start;
}

// Set the reference (operator reset). Records a price point so charts and the 24 h change follow.
// A reset (reason "reset") also starts the day's open and the high/low window over.
export function setReference(gpuId: GpuId, price: string, reason: string): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO share_reference (gpu_id, price, updated_at, reason, reset_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(gpu_id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at, reason = excluded.reason,
       reset_at = CASE WHEN excluded.reason = 'reset' THEN excluded.reset_at ELSE share_reference.reset_at END`
  ).run(gpuId, Number(price).toFixed(6), at, reason, reason === "reset" ? at : null);
  priceMoved(gpuId);
}

// A payout was made: the share's reference rises by exactly what each share was paid.
export async function payoutMade(gpuId: GpuId, perShare: string): Promise<void> {
  const add = Number(perShare);
  if (!(add > 0)) return;
  const now = Number(await referencePrice(gpuId));
  setReference(gpuId, (now + add).toFixed(6), `payout ${Number(perShare).toFixed(6)} per share`);
}

async function readPrice(gpuId: GpuId): Promise<SharePrice> {
  const book = await xrpl.getShareBook(gpuId).catch(() => ({ bestBid: null, bestAsk: null }));
  const trade = lastTrade(gpuId);
  const out: SharePrice = { price: Number(await referencePrice(gpuId)).toFixed(6), source: "reference", ...book, lastTrade: trade?.price ?? null };
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
  // Loans' collateral price follows the market (marketMaker.ts).
  void import("./marketMaker.js").then((m) => m.syncOracle(gpuId)).catch(() => {});
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

// Today's opening price: the first price point since 00:00 UTC, or since a reset made today (or
// the price now, if none yet).
export function openPrice(gpuId: GpuId, price: string): string {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  // A reset of the reference today starts the day over from the reset price.
  const reset = db.prepare(`SELECT reset_at AS updated_at FROM share_reference WHERE gpu_id = ? AND reset_at IS NOT NULL`).get(gpuId) as { updated_at: string } | undefined;
  const from = reset && reset.updated_at > day.toISOString() ? reset.updated_at : day.toISOString();
  const first = db.prepare(`SELECT price FROM share_prices WHERE gpu_id = ? AND ts >= ? ORDER BY ts LIMIT 1`).get(gpuId, from) as { price: string } | undefined;
  return first && Number(first.price) > 0 ? Number(first.price).toFixed(6) : Number(price).toFixed(6);
}

// Start of the 24 h window for high and low: 24 hours ago, or the last price reset if later
// (prices before a reset belong to the old price).
export function priceWindowStart(gpuId: GpuId): string {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const reset = db.prepare(`SELECT reset_at AS updated_at FROM share_reference WHERE gpu_id = ? AND reset_at IS NOT NULL`).get(gpuId) as { updated_at: string } | undefined;
  return reset && reset.updated_at > since ? reset.updated_at : since;
}

// Percent change since today's opening price.
export function change24hPct(gpuId: GpuId, price: string): string {
  const open = Number(openPrice(gpuId, price));
  if (!(open > 0)) return "0.00";
  return ((Number(price) / open - 1) * 100).toFixed(2);
}

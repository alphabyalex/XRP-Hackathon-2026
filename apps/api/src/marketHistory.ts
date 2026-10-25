// Market history the GPU pages read: bookings and inference the api recorded
// (schedule bars, avatars), trailing revenue and dividends (yield). All of it
// comes from work a GPU actually served; nothing is generated (the old
// 24-hour backfill and its startup dividends are gone).

import { treasuryOf, type GpuId } from "@moonshift/shared";
import { db } from "./db/db.js";
import { startDevActivity } from "./devActivity.js";
import * as xrpl from "./adapters/xrplAdapter.js";
import { swr } from "./lending/swr.js";
import { sharePrice } from "./sharePrice.js";
import { quoteMarket } from "./marketMaker.js";

const HOUR = 3600e3;

// Bookings and inference the api recorded, as calendar entries (merged with compute's own).
export function historyCalendar(gpuId: GpuId, from: string, to: string) {
  const booked = db
    .prepare(`SELECT slot_start, slot_end, id FROM bookings WHERE gpu_id = ? AND slot_end > ? AND slot_start < ?`)
    .all(gpuId, from, to) as { slot_start: string; slot_end: string; id: string }[];
  const used = db
    .prepare(`SELECT started_at, finished_at, request_id FROM usage_events WHERE gpu_id = ? AND finished_at > ? AND started_at < ?`)
    .all(gpuId, from, to) as { started_at: string; finished_at: string; request_id: string }[];
  return [
    ...booked.map((b) => ({ start: b.slot_start, end: b.slot_end, kind: "BOOKED", ref: b.id })),
    ...used.map((u) => ({ start: u.started_at, end: u.finished_at, kind: "INFERENCE", ref: u.request_id })),
  ];
}

// The GPU's treasury cash (its USDC balance on the ledger), refreshed at most once a minute.
const treasuryCash = swr<string>("treasury cash", 60_000, 30 * 60_000);

// Share of the last 24 hours the GPU was booked or serving inference (overlaps counted once).
export function utilization24hPct(gpuId: GpuId, now = Date.now()): number {
  const from = now - 24 * HOUR;
  const spans = historyCalendar(gpuId, new Date(from).toISOString(), new Date(now).toISOString())
    .map((e) => [Math.max(from, new Date(e.start).getTime()), Math.min(now, new Date(e.end).getTime())] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    busy += b - Math.max(a, end);
    end = b;
  }
  return Math.min(100, (busy / (24 * HOUR)) * 100);
}

// Inputs pricing needs for NAV and yield: the treasury's cash, real
// utilization, trailing revenue, dividends paid and the market share price.
export async function navInputs(gpuId: GpuId): Promise<Record<string, string>> {
  const since = new Date(Date.now() - 24 * HOUR).toISOString();
  const rev = db
    .prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS t FROM revenue_ledger WHERE gpu_id = ? AND created_at >= ?`)
    .get(gpuId, since) as { t: number };
  const weekAgo = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
  const paid = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(per_share AS REAL)), 0) AS t, MIN(period_start) AS first FROM dividend_runs WHERE gpu_id = ? AND status = 'paid' AND created_at >= ?`
    )
    .get(gpuId, weekAgo) as { t: number; first: string | null };
  const days = paid.first ? Math.max(1, (Date.now() - new Date(paid.first).getTime()) / (24 * HOUR)) : 1;
  const [cash, market] = await Promise.all([
    treasuryCash
      .get(gpuId, async () => (await xrpl.getBalances(treasuryOf(gpuId))).tokens.TDX ?? "0")
      .catch(() => null),
    sharePrice(gpuId).catch(() => null),
  ]);
  return {
    trailing_revenue_24h: rev.t.toFixed(6),
    trailing_dividends_per_share: paid.t.toFixed(6),
    trailing_period_days: days.toFixed(4),
    utilization_pct: utilization24hPct(gpuId).toFixed(2),
    ...(cash !== null ? { treasury_cash: Number(cash).toFixed(6) } : {}),
    // Yield against what a share costs on the market, not against NAV.
    ...(market ? { share_price: market.price } : {}),
  };
}

// Seed actual funded share liquidity, then bounded DEV-account ledger activity.
// Historical values are never backfilled.
export async function seedHistory(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { market: await quoteMarket() };
  startDevActivity();
  return out;
}

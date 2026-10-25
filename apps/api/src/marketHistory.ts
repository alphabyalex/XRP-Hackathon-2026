// Market history the GPU pages read: the last 24 hours of bookings and
// inference (schedule bars, avatars), trailing revenue and dividends (yield).
//
// A fresh devnet world has none, so seedHistory() fills the last 24 hours with
// the load simulator's labeled traffic (buyer SIM, simulated = 1) and pays one
// dividend per GPU from that revenue, before anyone opens the page. It is
// idempotent: ids are per GPU and hour, so a rerun only fills what is missing.

import { GPUS, type GpuId } from "@moonshift/shared";
import { db } from "./db/db.js";
import { addRevenue } from "./db/helpers.js";
import { approveDividendRun, proposeDividendRun } from "./dividends.js";
import { startSim } from "./sim.js";
import * as xrpl from "./adapters/xrplAdapter.js";
import { swr } from "./lending/swr.js";
import { sharePrice } from "./sharePrice.js";
import { quoteMarket } from "./marketMaker.js";

const HOUR = 3600e3;
// Charges like the simulator's own pings and a GPU-hour contract slot, sized so
// yield lands where a GPU lease does (roughly 10 to 20% a year at today's NAV).
const INFERENCE_CHARGE_PER_MIN = 0.0025;
const BOOKED_CHARGE_PER_MIN = 0.012;

// Deterministic per GPU and hour, so reruns produce the same history.
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function revenueOnce(gpuId: GpuId, source: "inference" | "contract", amount: number, ref: string, at: string) {
  if (db.prepare(`SELECT 1 FROM revenue_ledger WHERE ref = ?`).get(ref)) return;
  addRevenue(gpuId, source, amount.toFixed(6), ref);
  db.prepare(`UPDATE revenue_ledger SET created_at = ? WHERE ref = ?`).run(at, ref);
}

export function backfillHours(gpuId: GpuId, hours = 24, now = Date.now()): { inference: number; booked: number } {
  const topOfHour = Math.floor(now / HOUR) * HOUR;
  let inference = 0;
  let booked = 0;
  for (let k = hours; k >= 1; k--) {
    const hourStart = topOfHour - k * HOUR;
    const key = `${gpuId}_${new Date(hourStart).toISOString().slice(0, 13)}`;
    const r = rng(key);
    // A booked block in about a third of the hours (a renter's 30 to 90 minutes).
    let block: [number, number] | null = null;
    if (r() < 0.4) {
      const startMin = Math.floor(r() * 40);
      const len = 30 + Math.floor(r() * 4) * 15;
      block = [hourStart + startMin * 60e3, Math.min(hourStart + HOUR + 30 * 60e3, hourStart + (startMin + len) * 60e3)];
      const id = `simbk_${key}`;
      if (!db.prepare(`SELECT 1 FROM bookings WHERE id = ?`).get(id)) {
        db.prepare(`INSERT INTO bookings (id, gpu_id, slot_start, slot_end, holder, redemption_id) VALUES (?, ?, ?, ?, 'SIM', NULL)`).run(
          id,
          gpuId,
          new Date(block[0]).toISOString(),
          new Date(block[1]).toISOString()
        );
        booked++;
      }
      revenueOnce(gpuId, "contract", ((block[1] - block[0]) / 60e3) * BOOKED_CHARGE_PER_MIN, id, new Date(block[1]).toISOString());
    }
    // Inference: 4 to 9 requests of 1 to 4 minutes, outside the booked block.
    const n = 4 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const start = hourStart + Math.floor(r() * 56) * 60e3;
      const mins = 1 + Math.floor(r() * 4);
      const end = start + mins * 60e3;
      if (block && start < block[1] && end > block[0]) continue;
      const id = `sim_${key}_${i}`;
      if (!db.prepare(`SELECT 1 FROM usage_events WHERE request_id = ?`).get(id)) {
        const tokensIn = 40 + Math.floor(r() * 200);
        const tokensOut = 80 + Math.floor(r() * 400);
        db.prepare(
          `INSERT INTO usage_events (request_id, gpu_id, buyer, booking_id, input_tokens, output_tokens, charge, started_at, finished_at, simulated)
           VALUES (?, ?, 'SIM', NULL, ?, ?, ?, ?, ?, 1)`
        ).run(id, gpuId, tokensIn, tokensOut, (mins * INFERENCE_CHARGE_PER_MIN).toFixed(6), new Date(start).toISOString(), new Date(end).toISOString());
        inference++;
      }
      revenueOnce(gpuId, "inference", mins * INFERENCE_CHARGE_PER_MIN, id, new Date(end).toISOString());
    }
  }
  return { inference, booked };
}

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
const TREASURY: Record<GpuId, "TREASURY_GPU_A" | "TREASURY_GPU_B"> = { "gpu-a": "TREASURY_GPU_A", "gpu-b": "TREASURY_GPU_B" };

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
      .get(gpuId, async () => (await xrpl.getBalances(TREASURY[gpuId])).tokens.TDX ?? "0")
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

// Startup and demo:reset: fill the last 24 hours, pay one dividend per GPU if
// none was paid in that window, keep the live simulator running.
export async function seedHistory(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const g of GPUS) {
    const filled = backfillHours(g.id);
    const recent = db
      .prepare(`SELECT id FROM dividend_runs WHERE gpu_id = ? AND status = 'paid' AND created_at >= ?`)
      .get(g.id, new Date(Date.now() - 24 * HOUR).toISOString());
    let dividend: unknown = recent ? "already paid in the last 24 hours" : null;
    if (!recent) {
      try {
        const run = await proposeDividendRun(g.id);
        const paid = await approveDividendRun(run.id);
        dividend = { run: run.id, distributable: run.distributable, status: paid.status, txs: paid.txs };
      } catch (e) {
        dividend = `not paid: ${(e as Error).message}`;
      }
    }
    out[g.id] = { ...filled, dividend };
  }
  // Two-sided share books around each GPU's NAV (marketMaker.ts).
  out.market = await quoteMarket();
  startSim();
  return out;
}

import { randomUUID } from "crypto";
import { db } from "./db.js";
import { explorerUrl } from "@moonshift/shared";
import type { TxResult } from "@moonshift/shared";

// A user's account reads as their wallet (rLfW…sbTs), not its internal U_<address> name.
function readable(summary: string): string {
  return summary.replace(/U_(r[1-9A-HJ-NP-Za-km-z]{24,34})/g, (_m, addr: string) => {
    const row = db.prepare(`SELECT wallet_address FROM users WHERE account_address = ?`).get(addr) as { wallet_address: string } | undefined;
    const w = row?.wallet_address ?? addr;
    return `${w.slice(0, 4)}…${w.slice(-4)}`;
  });
}

export function logTx(tx: TxResult, kind: string, account: string, summary: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO tx_log (hash, kind, account, summary, explorer_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tx.hash, kind, account, readable(summary), tx.explorerUrl || explorerUrl(tx.hash), new Date().toISOString());
}

export function addRevenue(gpuId: string, source: "inference" | "contract", amount: string, ref: string | null): void {
  db.prepare(
    `INSERT INTO revenue_ledger (id, gpu_id, source, amount, ref, created_at, dividend_run_id) VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(randomUUID(), gpuId, source, amount, ref, new Date().toISOString());
}

export interface UsageEventInput {
  request_id: string;
  gpu_id: string;
  buyer: string;
  booking_id: string | null;
  input_tokens: number;
  output_tokens: number;
  charge: string;
  started_at: string;
  finished_at: string;
  simulated?: boolean;
}

export function recordUsage(e: UsageEventInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO usage_events (request_id, gpu_id, buyer, booking_id, input_tokens, output_tokens, charge, started_at, finished_at, simulated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.request_id,
    e.gpu_id,
    e.buyer,
    e.booking_id,
    e.input_tokens,
    e.output_tokens,
    e.charge,
    e.started_at,
    e.finished_at,
    e.simulated ? 1 : 0
  );
  if (Number(e.charge) > 0) {
    addRevenue(e.gpu_id, "inference", e.charge, e.request_id);
  }
}

export function unassignedRevenue(gpuId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM revenue_ledger WHERE gpu_id = ? AND dividend_run_id IS NULL`)
    .get(gpuId) as { total: number };
  return row.total;
}

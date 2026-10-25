// Dividend runs: propose (pricing splits the unassigned revenue across the
// share holders) and approve (one XRPL Batch pays every holder). Used by the
// admin routes and by the startup history seed.

import { randomUUID } from "crypto";
import type { GpuId } from "@moonshift/shared";
import * as xrpl from "./adapters/xrplAdapter.js";
import * as pricing from "./adapters/pricingClient.js";
import { db } from "./db/db.js";
import { logTx, unassignedRevenue } from "./db/helpers.js";
import { broadcast } from "./sse.js";

export async function proposeDividendRun(gpuId: GpuId) {
  const grossRevenue = unassignedRevenue(gpuId).toFixed(6);
  const holders = await xrpl.getHolders(gpuId);
  const oldestRow = db
    .prepare(`SELECT MIN(created_at) as t FROM revenue_ledger WHERE gpu_id = ? AND dividend_run_id IS NULL`)
    .get(gpuId) as { t: string | null };
  const periodStart = oldestRow.t ?? new Date().toISOString();
  const periodEnd = new Date().toISOString();

  const proposal = await pricing.proposeDividends({
    gpu_id: gpuId,
    period_start: periodStart,
    period_end: periodEnd,
    gross_revenue: grossRevenue,
    holders: holders.map((h) => ({ account: h.account, shares: h.shares })),
  });

  const runId = `div_${randomUUID()}`;
  db.prepare(
    `INSERT INTO dividend_runs (id, gpu_id, period_start, period_end, gross_revenue, hosting_fee, reserve, distributable, status, explanation, created_at, per_share)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`
  ).run(
    runId,
    gpuId,
    periodStart,
    periodEnd,
    grossRevenue,
    proposal.hosting_fee,
    proposal.reserve,
    proposal.distributable,
    proposal.explanation,
    new Date().toISOString(),
    String((proposal as { per_share?: string }).per_share ?? "0")
  );
  for (const payout of proposal.payouts) {
    db.prepare(`INSERT INTO payouts (id, dividend_run_id, account, amount, tx_hash) VALUES (?, ?, ?, ?, NULL)`).run(
      randomUUID(),
      runId,
      payout.account,
      payout.amount
    );
  }
  // Lock in this revenue so a second proposal before approval doesn't double count it.
  db.prepare(`UPDATE revenue_ledger SET dividend_run_id = ? WHERE gpu_id = ? AND dividend_run_id IS NULL`).run(runId, gpuId);

  broadcast("dividend", { id: runId, status: "proposed" });
  return {
    id: runId,
    gpuId,
    periodStart,
    periodEnd,
    grossRevenue,
    hostingFee: proposal.hosting_fee,
    reserve: proposal.reserve,
    distributable: proposal.distributable,
    status: "proposed" as const,
    explanation: proposal.explanation,
    createdAt: new Date().toISOString(),
    payouts: proposal.payouts,
  };
}

export class DividendRunError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export async function approveDividendRun(runId: string) {
  const run = db.prepare(`SELECT * FROM dividend_runs WHERE id = ?`).get(runId) as any;
  if (!run) throw new DividendRunError(404, "NOT_FOUND", "unknown dividend run");
  if (run.status !== "proposed") throw new DividendRunError(409, "ALREADY_SETTLED", `run is already ${run.status}`);

  const payoutRows = db.prepare(`SELECT * FROM payouts WHERE dividend_run_id = ?`).all(runId) as any[];
  const results = await xrpl.payDividends({
    gpuId: run.gpu_id,
    payouts: payoutRows.map((p) => ({ account: p.account, amount: p.amount })),
    hostingFee: run.hosting_fee,
  });

  const allOk = results.every((r) => r.result === "tesSUCCESS");
  db.prepare(`UPDATE dividend_runs SET status = ? WHERE id = ?`).run(allOk ? "paid" : "failed", runId);

  payoutRows.forEach((p, i) => {
    const tx = results[i];
    db.prepare(`UPDATE payouts SET tx_hash = ? WHERE id = ?`).run(tx.hash, p.id);
    logTx(tx, "payDividends", p.account, `${p.account} received ${p.amount} TDX dividend from ${run.gpu_id}`);
  });
  const feeTx = results[results.length - 1];
  if (feeTx) logTx(feeTx, "payDividends.fee", "PROTOCOL_FEES", `hosting fee ${run.hosting_fee} TDX from ${run.gpu_id}`);

  broadcast("dividend", { id: runId, status: allOk ? "paid" : "failed" });
  const updatedPayouts = db.prepare(`SELECT account, amount, tx_hash FROM payouts WHERE dividend_run_id = ?`).all(runId);
  return { id: runId, status: allOk ? ("paid" as const) : ("failed" as const), payouts: updatedPayouts, txs: results.map((r) => r.hash) };
}

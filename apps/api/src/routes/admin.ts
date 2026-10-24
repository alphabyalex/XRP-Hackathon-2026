import { Router } from "express";
import { randomUUID } from "crypto";
import type { GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import { db, resetDb } from "../db/db.js";
import { logTx, unassignedRevenue } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import { startSim, stopSim, isSimRunning } from "../sim.js";

export const adminRouter = Router();

adminRouter.post("/dividends/propose", async (req, res) => {
  const { gpuId } = req.body as { gpuId: GpuId };
  if (!gpuId) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "gpuId required" } });
    return;
  }
  try {
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
      `INSERT INTO dividend_runs (id, gpu_id, period_start, period_end, gross_revenue, hosting_fee, reserve, distributable, status, explanation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`
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
      new Date().toISOString()
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
    db.prepare(`UPDATE revenue_ledger SET dividend_run_id = ? WHERE gpu_id = ? AND dividend_run_id IS NULL`).run(
      runId,
      gpuId
    );

    broadcast("dividend", { id: runId, status: "proposed" });
    res.json({
      id: runId,
      gpuId,
      periodStart,
      periodEnd,
      grossRevenue,
      hostingFee: proposal.hosting_fee,
      reserve: proposal.reserve,
      distributable: proposal.distributable,
      status: "proposed",
      explanation: proposal.explanation,
      createdAt: new Date().toISOString(),
      payouts: proposal.payouts,
    });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

adminRouter.post("/dividends/:id/approve", async (req, res) => {
  const runId = req.params.id;
  const run = db.prepare(`SELECT * FROM dividend_runs WHERE id = ?`).get(runId) as any;
  if (!run) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown dividend run" } });
    return;
  }
  if (run.status !== "proposed") {
    res.status(409).json({ error: { code: "ALREADY_SETTLED", message: `run is already ${run.status}` } });
    return;
  }
  try {
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
    res.json({ id: runId, status: allOk ? "paid" : "failed", payouts: updatedPayouts });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

adminRouter.post("/oracle/publish", async (req, res) => {
  const { gpuId } = req.body as { gpuId: GpuId };
  if (!gpuId) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "gpuId required" } });
    return;
  }
  try {
    const [nav, gpus] = await Promise.all([pricing.getNav(gpuId), compute.getGpus()]);
    const state = gpus.find((g) => g.id === gpuId);
    const tx = await xrpl.publishOracle({
      gpuId,
      navPerShare: nav.nav_per_share,
      gpuHourPrice: "4.950000",
      utilizationPct: String(state?.utilization_pct_1h ?? 0),
    });
    logTx(tx, "publishOracle", "ORACLE", `published oracle for ${gpuId}`);
    broadcast("tx", { hash: tx.hash, kind: "publishOracle", account: "ORACLE" });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

adminRouter.post("/demo/reset", async (_req, res) => {
  resetDb();
  xrpl.resetMockLedger();
  compute.resetMockCompute();
  stopSim();
  res.json({ ok: true, message: "Demo state reset: SQLite tables cleared, simulator stopped." });
});

adminRouter.post("/sim/start", (_req, res) => {
  startSim();
  res.json({ ok: true, simRunning: isSimRunning() });
});

adminRouter.post("/sim/stop", (_req, res) => {
  stopSim();
  res.json({ ok: true, simRunning: isSimRunning() });
});

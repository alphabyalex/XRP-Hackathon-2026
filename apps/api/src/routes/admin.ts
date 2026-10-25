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
import { DividendRunError, approveDividendRun, proposeDividendRun } from "../dividends.js";

export const adminRouter = Router();

adminRouter.post("/dividends/propose", async (req, res) => {
  const { gpuId } = req.body as { gpuId: GpuId };
  if (!gpuId) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "gpuId required" } });
    return;
  }
  try {
    res.json(await proposeDividendRun(gpuId));
  } catch (err) {
    const e = err as any;
    res.status(e instanceof DividendRunError ? e.status : 500).json({ error: { code: e.code ?? "INTERNAL", message: e.message } });
  }
});

adminRouter.post("/dividends/:id/approve", async (req, res) => {
  try {
    const { id, status, payouts } = await approveDividendRun(req.params.id);
    res.json({ id, status, payouts });
  } catch (err) {
    const e = err as any;
    res.status(e instanceof DividendRunError ? e.status : 500).json({ error: { code: e.code ?? "INTERNAL", message: e.message } });
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

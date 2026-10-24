import { Router } from "express";
import { GPUS, type GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import { db } from "../db/db.js";

export const gpusRouter = Router();

async function buildSummary(gpuId: GpuId) {
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const [computeGpus, nav, holders] = await Promise.all([
    compute.getGpus(),
    pricing.getNav(gpuId),
    xrpl.getHolders(gpuId),
  ]);
  const computeState = computeGpus.find((c) => c.id === gpuId);

  return {
    id: gpu.id,
    label: gpu.label,
    hw: gpu.hw,
    model: gpu.model,
    state: computeState?.state ?? "OFFLINE",
    simulated: computeState?.simulated ?? false,
    sharePrice: "1.050000",
    navPerShare: nav.nav_per_share,
    revenue24h: nav.trailing_revenue_24h,
    utilizationPct: String(computeState?.utilization_pct_1h ?? 0),
    impliedYieldPct: nav.implied_yield_pct,
    holdersCount: holders.length,
  };
}

gpusRouter.get("/gpus", async (_req, res) => {
  try {
    const summaries = await Promise.all(GPUS.map((g) => buildSummary(g.id)));
    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

gpusRouter.get("/gpus/:id", async (req, res) => {
  const gpuId = req.params.id as GpuId;
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown gpuId" } });
    return;
  }
  try {
    const summary = await buildSummary(gpuId);
    const now = new Date();
    // Same window the web schedule draws: 20 hours back, 4 hours ahead.
    const from = new Date(now.getTime() - 21 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const [calendar, holders] = await Promise.all([
      compute.getCalendar(gpuId, from, to),
      xrpl.getHolders(gpuId),
    ]);
    const recentRequests = db
      .prepare(`SELECT * FROM usage_events WHERE gpu_id = ? ORDER BY started_at DESC LIMIT 20`)
      .all(gpuId);
    const oracle = xrpl.getOracle(gpuId);

    res.json({ ...summary, calendar, recentRequests, holders, oracle });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

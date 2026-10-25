import { Router } from "express";
import { GPUS, RESOURCE_BREAKDOWN, type GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import { db } from "../db/db.js";
import { historyCalendar } from "../marketHistory.js";
import { change24hPct, priceHistory, sharePrice } from "../sharePrice.js";
import { gpuHealth, isListed, listedGpus } from "../gpuHealth.js";
import { gpuStats, payoutYield } from "../gpuStats.js";

export const gpusRouter = Router();

async function buildSummary(gpuId: GpuId) {
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const [computeGpus, nav, holders, market] = await Promise.all([
    compute.getGpus(),
    pricing.getNav(gpuId),
    xrpl.getHolders(gpuId),
    sharePrice(gpuId),
  ]);
  const computeState = computeGpus.find((c) => c.id === gpuId);

  return {
    id: gpu.id,
    label: gpu.label,
    hw: gpu.hw,
    // A real GPU's label is what its endpoint reports serving (gpuHealth.ts); the registry otherwise.
    model: gpuHealth().find((h) => h.gpuId === gpuId && h.kind === "real")?.model ?? gpu.model,
    // Where a real GPU runs; none for the mock GPU (it is not hosted anywhere).
    provider: gpuHealth().some((h) => h.gpuId === gpuId && h.kind === "real") ? (gpu as any).provider ?? null : null,
    state: computeState?.state ?? "OFFLINE",
    simulated: false,
    // The one share price (sharePrice.ts reference).
    sharePrice: market.price,
    priceSource: market.source,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    change24hPct: change24hPct(gpuId, market.price),
    navPerShare: nav.nav_per_share,
    revenue24h: nav.trailing_revenue_24h,
    utilizationPct: String(computeState?.utilization_pct_1h ?? 0),
    // Last 24 h of payouts per share, annualized at the share price (gpuStats.payoutYield).
    impliedYieldPct: payoutYield(gpuId, market.price).yieldPct ?? "0.00",
    holdersCount: holders.length,
    monteCarlo: (computeState as any)?.monte_carlo,
    // Hosting and its cost breakdown: real hardware only.
    resources: gpuHealth().some((h) => h.gpuId === gpuId && h.kind === "real") ? RESOURCE_BREAKDOWN[gpuId] : undefined,
  };
}

gpusRouter.get("/pricing/resources", async (_req, res) => {
  res.json(RESOURCE_BREAKDOWN);
});

gpusRouter.get("/monte-carlo/status", async (_req, res) => {
  try {
    const status = await compute.getMonteCarloStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

gpusRouter.post("/monte-carlo/switch-demo", async (req, res) => {
  try {
    const gpuId = (req.query.gpu_id as string) || "gpu-a";
    const prompt = (req.query.prompt as string) || (req.body?.prompt as string);
    const result = await compute.runSwitchDemo(gpuId, prompt);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

// Per GPU: real hardware (endpoint up, model it serves), the mock worker, or hidden. No endpoint URLs.
gpusRouter.get("/gpus-health", (_req, res) => res.json(gpuHealth()));

gpusRouter.get("/gpus", async (_req, res) => {
  try {
    // Only GPUs whose endpoint passed its health check, plus the mock GPU (gpuHealth.ts).
    const summaries = await Promise.all(listedGpus().map((g) => buildSummary(g.id)));
    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

// One GPU's market and earnings (contracts/api/gpu_stats.json).
gpusRouter.get("/gpus/:id/stats", async (req, res) => {
  const gpuId = req.params.id as GpuId;
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu || !isListed(gpuId)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: gpu ? "GPU not online" : "unknown gpuId" } });
    return;
  }
  try {
    res.json(await gpuStats(gpuId));
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

gpusRouter.get("/gpus/:id", async (req, res) => {
  const gpuId = req.params.id as GpuId;
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu || !isListed(gpuId)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: gpu ? "GPU not online" : "unknown gpuId" } });
    return;
  }
  try {
    const summary = await buildSummary(gpuId);
    const now = new Date();
    // Same window the web schedule draws: 20 hours back, 4 hours ahead.
    const from = new Date(now.getTime() - 21 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const [live, holders] = await Promise.all([compute.getCalendar(gpuId, from, to), xrpl.getHolders(gpuId)]);
    // compute keeps only upcoming bookings and the last 2 hours of inference;
    // the api's records add the rest of the window.
    const calendar = [...live, ...historyCalendar(gpuId, from, to)].sort((a, b) => a.start.localeCompare(b.start));
    const recentRequests = db
      .prepare(`SELECT * FROM usage_events WHERE gpu_id = ? ORDER BY started_at DESC LIMIT 20`)
      .all(gpuId);
    const oracle = xrpl.getOracle(gpuId);

    res.json({ ...summary, calendar, recentRequests, holders, oracle, priceHistory: priceHistory(gpuId) });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

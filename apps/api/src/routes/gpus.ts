import { Router } from "express";
import { GPUS, type GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import { db } from "../db/db.js";
import { historyCalendar } from "../marketHistory.js";
import { change24hPct, priceHistory, sharePrice } from "../sharePrice.js";
import { gpuHealth, isListed, listedGpus } from "../gpuHealth.js";
import { gpuStats, payoutYield } from "../gpuStats.js";
import { verifiedGpuResources, verifiedGpuSpec } from "../marketData/rentalCatalog.js";
import { canSignGpuTreasury } from "../treasuryCapabilities.js";
import { requirePromptFunding } from "../middleware/funding.js";
import { swr } from "../lending/swr.js";
import { onDataEvent } from "../sse.js";

export const gpusRouter = Router();
const summaries = swr<Awaited<ReturnType<typeof buildSummary>>>("gpu-summary", 1500, 6000);
const details = swr<Awaited<ReturnType<typeof buildDetail>>>("gpu-detail", 1500, 6000);
const stats = swr<Awaited<ReturnType<typeof gpuStats>>>("gpu-stats", 1500, 6000);
onDataEvent(() => { summaries.invalidate(); details.invalidate(); stats.invalidate(); });
const summaryFor = (id: GpuId) => summaries.get(id, () => buildSummary(id));

async function buildSummary(gpuId: GpuId) {
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const [computeGpus, nav, holders, market] = await Promise.all([
    compute.getGpus(),
    pricing.getNav(gpuId),
    xrpl.getHolders(gpuId),
    sharePrice(gpuId),
  ]);
  const computeState = computeGpus.find((c) => c.id === gpuId);
  const verified = verifiedGpuSpec(gpuId);

  return {
    id: gpu.id,
    label: gpu.label,
    hw: verified ? `${verified.card} ${verified.vramGb}GB` : "Hardware verification pending",
    // A real GPU's label is what its endpoint reports serving (gpuHealth.ts); the registry otherwise.
    model: gpuHealth().find((h) => h.gpuId === gpuId && h.kind === "real")?.model ?? verified?.modelId ?? "Model verification pending",
    // Where a real GPU runs; none for the mock GPU (it is not hosted anywhere).
    provider: verified?.provider ?? "Provider verification pending",
    location: verified ? { city: verified.city, region: verified.region } : { city: null, region: null },
    state: computeState?.state ?? "OFFLINE",
    simulated: false,
    capabilities: { rental: Boolean(verified?.rental), treasuryPayments: canSignGpuTreasury(gpuId) },
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
    resources: verifiedGpuResources(gpuId),
  };
}

gpusRouter.get("/pricing/resources", async (_req, res) => {
  res.json(Object.fromEntries(listedGpus().flatMap(gpu => {
    const resources = verifiedGpuResources(gpu.id);
    return resources ? [[gpu.id, resources]] : [];
  })));
});

gpusRouter.get("/monte-carlo/status", async (_req, res) => {
  try {
    const status = await compute.getMonteCarloStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

gpusRouter.post("/monte-carlo/switch-demo", requirePromptFunding, async (req, res) => {
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
    const rows = await Promise.all(listedGpus().map((g) => summaryFor(g.id)));
    res.json(rows.filter(g => isListed(g.id)));
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
    res.json(await stats.get(gpuId, () => gpuStats(gpuId)));
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
    res.json(await details.get(gpuId, () => buildDetail(gpuId)));
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

async function buildDetail(gpuId: GpuId) {
    const summary = await summaryFor(gpuId);
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

    return { ...summary, calendar, recentRequests, holders, oracle, priceHistory: priceHistory(gpuId) };
}

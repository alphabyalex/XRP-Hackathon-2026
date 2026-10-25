import { Router } from "express";
import { db } from "../db/db.js";
import { getRentalCatalog } from "../marketData/rentalCatalog.js";
import { modelsForGpu, observedOutputThroughput } from "../marketData/modelCatalog.js";

// Older builds could mark generated responses as real. Only work observed after
// this version starts is eligible to price tokens until durable provenance exists.
const measurementStartedAt = Date.now();

export const modelsRouter = Router();
modelsRouter.get("/models", async (req, res) => {
  const gpuId = req.query.gpuId;
  if (gpuId !== undefined && (typeof gpuId !== "string" || !/^gpu-[a-z]$/.test(gpuId))) {
    res.status(400).json({ error: { code: "INVALID_GPU", message: "gpuId must identify a GPU." } }); return;
  }
  try {
    const catalog = await getRentalCatalog();
    const gpus = catalog.gpus.filter(g => !gpuId || g.id === gpuId);
    const models = gpus.flatMap(gpu => {
      const notBefore = Math.max(measurementStartedAt, Date.now() - 24 * 3600_000);
      const observations = db.prepare(`SELECT output_tokens,started_at,finished_at FROM usage_events
        WHERE gpu_id=? AND simulated=0 AND output_tokens>0 AND started_at>=?`)
        .all(gpu.id, new Date(notBefore).toISOString()).map(row => ({
          output_tokens: Number(row.output_tokens), started_at: String(row.started_at), finished_at: String(row.finished_at),
        }));
      return modelsForGpu(gpu, observedOutputThroughput(observations, notBefore));
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ updatedAt: catalog.updatedAt, gpuId: gpuId ?? null, models });
  } catch {
    res.status(503).json({ error: { code: "MODELS_UNAVAILABLE", message: "The model catalog is temporarily unavailable." } });
  }
});

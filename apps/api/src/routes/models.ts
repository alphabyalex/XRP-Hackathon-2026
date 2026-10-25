import { Router } from "express";
import { db } from "../db/db.js";
import { getRentalCatalog } from "../marketData/rentalCatalog.js";
import { modelsForGpu } from "../marketData/modelCatalog.js";

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
      const observations = db.prepare(`SELECT output_tokens,started_at,finished_at FROM usage_events
        WHERE gpu_id=? AND simulated=0 AND output_tokens>0 AND finished_at>=?`)
        .all(gpu.id, new Date(Date.now() - 24 * 3600_000).toISOString()) as { output_tokens: number; started_at: string; finished_at: string }[];
      let tokens = 0, seconds = 0;
      for (const row of observations) {
        const elapsed = (Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000;
        if (elapsed > 0 && Number.isFinite(elapsed)) { tokens += row.output_tokens; seconds += elapsed; }
      }
      return modelsForGpu(gpu, seconds > 0 ? tokens / seconds : null);
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ updatedAt: catalog.updatedAt, gpuId: gpuId ?? null, models });
  } catch {
    res.status(503).json({ error: { code: "MODELS_UNAVAILABLE", message: "The model catalog is temporarily unavailable." } });
  }
});

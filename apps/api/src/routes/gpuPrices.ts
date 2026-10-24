import { Router } from "express";
import { getGpuPrices } from "../marketData/gpuPrices.js";

export const gpuPricesRouter = Router();
gpuPricesRouter.get("/gpu-prices", async (_req, res) => {
  try {
    const prices = await getGpuPrices();
    if (!prices) { res.status(503).json({ error: { code: "PRICES_UNAVAILABLE", message: "GPU prices are temporarily unavailable" } }); return; }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(prices);
  } catch {
    res.status(503).json({ error: { code: "PRICES_UNAVAILABLE", message: "GPU prices are temporarily unavailable" } });
  }
});

import { Router } from "express";
import { cachedAwsPrices, getRentalCatalog, startRentalCatalogPolling } from "../marketData/rentalCatalog.js";

export const catalogRouter = Router();
catalogRouter.get("/catalog/gpus", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getRentalCatalog());
  } catch {
    res.status(503).json({ error: { code: "CATALOG_UNAVAILABLE", message: "The rental catalog is temporarily unavailable." } });
  }
});
catalogRouter.get("/catalog/aws", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(cachedAwsPrices());
});
// Imported by the single index.ts mount. Refreshes continue even without a page open.
queueMicrotask(startRentalCatalogPolling);

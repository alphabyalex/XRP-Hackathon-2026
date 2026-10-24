import { Router } from "express";
import { recordUsage } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import type { UsageEvent } from "@moonshift/shared";

export const internalRouter = Router();

// Called by services/compute after each real inference request.
internalRouter.post("/usage", (req, res) => {
  const e = req.body as UsageEvent;
  if (!e.request_id || !e.gpu_id || !e.buyer) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "request_id, gpu_id, buyer required" } });
    return;
  }
  recordUsage(e);
  broadcast("usage", e);
  res.json({ ok: true });
});

import { Router } from "express";
import { seedHistory } from "../marketHistory.js";
import { recordUsage } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import type { CreditEvent, KeeperActionBody, UsageEvent } from "@moonshift/shared";
import { db } from "../db/db.js";
import * as svc from "../lending/service.js";
import { handle } from "./lending.js";

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

// ---------------------------------------------------------------------------
// Risk keeper (Kristian, services/risk). All idempotent by idempotencyKey; the
// api and packages/xrpl own every ledger transaction.
// ---------------------------------------------------------------------------

internalRouter.get(
  "/loans",
  handle(async () => ({ loans: await svc.keeperLoans() }))
);

internalRouter.post(
  "/loans/:id/margin-call",
  handle(async (req) => svc.marginCall(req.params.id, keeperBody(req.body), "risk-keeper"))
);

internalRouter.post(
  "/loans/:id/liquidate",
  handle(async (req) => svc.liquidate(req.params.id, keeperBody(req.body), "risk-keeper"))
);

internalRouter.get(
  "/oracle/:gpuId/history",
  handle(async (req) => ({
    gpuId: req.params.gpuId,
    prices: svc.oracleHistory(req.params.gpuId, req.query.from as string | undefined, req.query.to as string | undefined),
  }))
);

// Fund the live order book and start bounded real DEV ledger activity. No historical backfill.
internalRouter.post("/seed-history", handle(async () => seedHistory()));

// Credit events (Lucy, services/credit). Duplicate ids are ignored.
internalRouter.post(
  "/credit-events",
  handle(async (req) => {
    const e = req.body as CreditEvent;
    if (!e?.id || !e?.kind || !e?.address) throw new svc.LendingError("BAD_REQUEST", "id, kind, address required");
    // A live rescore: drop the cached profile before /borrow refetches it.
    const borrower = (e as any).borrower;
    if (e.kind === "PROFILE_CHANGED" && typeof borrower === "string") svc.creditProfileChanged(borrower);
    const r = db
      .prepare(`INSERT OR IGNORE INTO credit_events (id, kind, address, body, received_at) VALUES (?, ?, ?, ?, ?)`)
      .run(e.id, e.kind, e.address, JSON.stringify(e), new Date().toISOString());
    if (Number(r.changes) > 0) broadcast("credit", e);
    return { ok: true, duplicate: Number(r.changes) === 0 };
  })
);

function keeperBody(b: any): KeeperActionBody {
  if (!b?.idempotencyKey) throw new svc.LendingError("BAD_REQUEST", "idempotencyKey required");
  return {
    idempotencyKey: String(b.idempotencyKey),
    observedLtv: String(b.observedLtv ?? "0"),
    threshold: String(b.threshold ?? "0"),
    occurredAt: String(b.occurredAt ?? new Date().toISOString()),
    reason: String(b.reason ?? ""),
  };
}

import { Router } from "express";
import { db } from "../db/db.js";

export const txRouter = Router();

txRouter.get("/tx", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM tx_log ORDER BY created_at DESC LIMIT 50`).all();
  res.json(
    rows.map((r: any) => ({
      hash: r.hash,
      kind: r.kind,
      account: r.account,
      summary: r.summary,
      explorerUrl: r.explorer_url,
      createdAt: r.created_at,
    }))
  );
});

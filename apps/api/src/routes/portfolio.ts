import { Router } from "express";
import { GPUS } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import { db } from "../db/db.js";
import { asActor } from "../middleware/session.js";

export const portfolioRouter = Router();

portfolioRouter.get("/portfolio/:account", asActor("params", "account"), async (req, res) => {
  const account = req.params.account;
  try {
    const balances = await xrpl.getBalances(account as any);
    const shares = GPUS.map((g) => ({ gpuId: g.id, qty: balances.tokens[g.shareCode] ?? "0" })).filter(
      (s) => Number(s.qty) > 0
    );
    const contracts = GPUS.map((g) => ({ gpuId: g.id, qty: balances.tokens[g.contractCode] ?? "0" })).filter(
      (c) => Number(c.qty) > 0
    );
    const payoutRow = db
      .prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM payouts WHERE account = ?`)
      .get(account) as { total: number };
    const loans = db.prepare(`SELECT * FROM loans WHERE borrower = ?`).all(account);

    res.json({
      account,
      tdxBalance: balances.tokens.TDX ?? "0.000000",
      shares,
      contracts,
      dividendsReceived: payoutRow.total.toFixed(6),
      loans: loans.map((l: any) => ({
        id: l.id,
        borrower: l.borrower,
        gpuId: l.gpu_id,
        collateralShares: l.collateral_shares,
        principal: l.principal,
        dueAt: l.due_at,
        status: l.status,
        escrowTx: l.escrow_tx,
        disburseTx: l.disburse_tx,
        settleTx: l.settle_tx,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

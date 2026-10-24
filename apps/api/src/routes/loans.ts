import { Router } from "express";
import type { GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as pricing from "../adapters/pricingClient.js";
import { db } from "../db/db.js";
import { logTx } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import * as svc from "../lending/service.js";
import { lendingAvailable } from "../adapters/lendingAdapter.js";
import { actorFor } from "../middleware/session.js";

export const loansRouter = Router();

loansRouter.post("/loans/open", async (req, res) => {
  // XLS-66 path: open from an accepted quote (POST /loans/quote first).
  if ((req.body as any)?.quoteId) {
    if (!lendingAvailable()) {
      res.status(409).json({ error: { code: "LENDING_UNAVAILABLE", message: "XLS-66 lending needs NETWORK=devnet (or MOCK_XRPL=1)" } });
      return;
    }
    try {
      res.json(await svc.openFromQuote((req.body as any).quoteId, (b) => actorFor(req, b)));
    } catch (e) {
      const err = e as any;
      res.status(typeof err?.status === "number" ? err.status : 500).json({ error: { code: err.code ?? "INTERNAL", message: err.message } });
    }
    return;
  }
  // Legacy testnet loan (pre XLS-66): acts for the signed-in account only.
  try {
    req.body = { ...(req.body ?? {}), borrower: actorFor(req, (req.body as any)?.borrower) };
  } catch (e) {
    res.status(401).json({ error: { code: "NOT_CONNECTED", message: (e as Error).message } });
    return;
  }
  const { borrower, gpuId, collateralShares } = req.body as {
    borrower: string;
    gpuId: GpuId;
    collateralShares: string;
  };
  if (!borrower || !gpuId || !collateralShares) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "borrower, gpuId, collateralShares required" } });
    return;
  }
  try {
    const quote = await pricing.quoteLoan({ gpu_id: gpuId, shares: collateralShares });
    const dueAt = new Date(Date.now() + quote.term_minutes * 60 * 1000).toISOString();

    const { loanId, escrowTx, disburseTx } = await xrpl.openLoan({
      borrower: borrower as any,
      gpuId,
      collateralShares,
      principal: quote.max_principal,
      dueAt,
    });
    if (escrowTx.result !== "tesSUCCESS") {
      res.status(409).json({
        error: {
          code: "INSUFFICIENT_COLLATERAL",
          message: `Not enough ${gpuId.toUpperCase()} shares to lock ${collateralShares} as collateral.`,
        },
      });
      return;
    }

    db.prepare(
      `INSERT INTO loans (id, borrower, gpu_id, collateral_shares, principal, due_at, status, escrow_tx, disburse_tx, settle_tx)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)`
    ).run(loanId, borrower, gpuId, collateralShares, quote.max_principal, dueAt, escrowTx.hash, disburseTx.hash);

    logTx(escrowTx, "openLoan.escrow", borrower, `${borrower} escrowed ${collateralShares} shares of ${gpuId} as loan collateral`);
    logTx(disburseTx, "openLoan.disburse", borrower, `${borrower} received ${quote.max_principal} TDX loan principal`);
    broadcast("loan", { id: loanId, status: "open" });

    res.json({
      id: loanId,
      borrower,
      gpuId,
      collateralShares,
      principal: quote.max_principal,
      dueAt,
      status: "open",
      escrowTx: escrowTx.hash,
      disburseTx: disburseTx.hash,
      settleTx: null,
    });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

loansRouter.post("/loans/:id/repay", async (req, res) => {
  const loanId = req.params.id;
  // XLS-66 loans: pay off, release collateral, delete the loan.
  if (db.prepare(`SELECT 1 FROM xls_loans WHERE id = ?`).get(loanId)) {
    try {
      res.json(await svc.repay(loanId, ((req.body ?? {}) as any).mode ?? "full", (b) => actorFor(req, b)));
    } catch (e) {
      const err = e as any;
      res.status(typeof err?.status === "number" ? err.status : 500).json({ error: { code: err.code ?? "INTERNAL", message: err.message } });
    }
    return;
  }
  const loan = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(loanId) as any;
  if (!loan) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown loanId" } });
    return;
  }
  if (loan.status !== "open") {
    res.status(409).json({ error: { code: "ALREADY_SETTLED", message: `loan is already ${loan.status}` } });
    return;
  }
  try {
    const tx = await xrpl.repayLoan({ loanId });
    db.prepare(`UPDATE loans SET status = 'repaid' WHERE id = ?`).run(loanId);
    logTx(tx, "repayLoan", loan.borrower, `${loan.borrower} repaid loan ${loanId}`);
    broadcast("loan", { id: loanId, status: "repaid" });

    const updated = db.prepare(`SELECT * FROM loans WHERE id = ?`).get(loanId) as any;
    res.json(toLoanRecord(updated));
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

export function toLoanRecord(l: any) {
  return {
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
  };
}

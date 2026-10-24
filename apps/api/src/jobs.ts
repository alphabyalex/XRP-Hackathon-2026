import { GPUS } from "@moonshift/shared";
import * as xrpl from "./adapters/xrplAdapter.js";
import * as pricing from "./adapters/pricingClient.js";
import { db } from "./db/db.js";
import { logTx } from "./db/helpers.js";
import { broadcast } from "./sse.js";

export function startBackgroundJobs(): void {
  // Refresh pricing NAV, hook point for a future cache. Keeps the pricing
  // service warm and gives us a place to broadcast NAV changes later.
  setInterval(async () => {
    for (const gpu of GPUS) {
      try {
        await pricing.getNav(gpu.id);
      } catch {
        // pricing unreachable, next tick will retry
      }
    }
  }, 30_000);

  // Auto-post the oracle, opt-in via ORACLE_AUTO=1.
  setInterval(async () => {
    if (process.env.ORACLE_AUTO !== "1") return;
    for (const gpu of GPUS) {
      try {
        const nav = await pricing.getNav(gpu.id);
        const tx = await xrpl.publishOracle({
          gpuId: gpu.id,
          navPerShare: nav.nav_per_share,
          gpuHourPrice: "4.950000",
          utilizationPct: nav.utilization_assumption,
        });
        logTx(tx, "publishOracle.auto", "ORACLE", `auto-published oracle for ${gpu.id}`);
        broadcast("tx", { hash: tx.hash, kind: "publishOracle.auto", account: "ORACLE" });
      } catch {
        // pricing or xrpl unreachable, next tick will retry
      }
    }
  }, 60_000);

  // Settle loans past due_at: EscrowCancel if repaid, EscrowFinish default if not.
  setInterval(async () => {
    const now = new Date().toISOString();
    // settle_tx IS NULL guards against re-settling: status alone can't tell
    // "repaid and settled" from "repaid, awaiting settlement" since both are 'repaid'.
    const dueLoans = db
      .prepare(`SELECT * FROM loans WHERE status IN ('open','repaid') AND settle_tx IS NULL AND due_at <= ?`)
      .all(now) as any[];
    for (const loan of dueLoans) {
      try {
        const tx = await xrpl.settleLoan({ loanId: loan.id });
        const finalStatus = loan.status === "repaid" ? "repaid" : "defaulted";
        db.prepare(`UPDATE loans SET status = ?, settle_tx = ? WHERE id = ?`).run(finalStatus, tx.hash, loan.id);
        logTx(tx, "settleLoan", loan.borrower, `loan ${loan.id} settled (${finalStatus})`);
        broadcast("loan", { id: loan.id, status: finalStatus });
      } catch {
        // next tick will retry
      }
    }
  }, 30_000);
}

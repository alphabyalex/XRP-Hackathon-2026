import { Router, type Request, type Response } from "express";
import type { GpuId, LoanQuoteApiRequest } from "@moonshift/shared";
import * as lending from "../adapters/lendingAdapter.js";
import * as credit from "../adapters/creditClient.js";
import * as risk from "../adapters/riskClient.js";
import { sources } from "../adapters/serviceFetch.js";
import { logTx } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import * as svc from "../lending/service.js";

export const lendingRouter = Router();

// Route wrapper: LendingError -> its status; ledger and service errors -> a
// readable message instead of a stack.
export function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e) {
      const err = e as any;
      if (err instanceof svc.LendingError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      const msg = String(err?.message ?? err);
      const code = /^([A-Z_]{4,}):/.exec(msg)?.[1] ?? (err?.code && typeof err.code === "string" ? err.code : "INTERNAL");
      const status = /NO_LENDING_ROUND|NO_SUBSCRIBING_ROUND|ROUND_|tec|NOT_CONFIGURED/.test(msg) ? 409 : 500;
      res.status(status).json({ error: { code, message: msg } });
    }
  };
}

// ---------------------------------------------------------------------------
// Vault (lenders)
// ---------------------------------------------------------------------------

lendingRouter.get("/vault", handle(async () => lending.vaultOverview()));

lendingRouter.get(
  "/vault/positions/:account",
  handle(async (req) => ({ account: req.params.account, positions: await lending.lenderPositions(svc.asAccountName(req.params.account)) }))
);

lendingRouter.post(
  "/vault/deposit",
  handle(async (req) => {
    const { lender, amount, round } = req.body as { lender: string; amount: string; round?: number };
    if (!lender || !(Number(amount) > 0)) throw new svc.LendingError("BAD_REQUEST", "lender and a positive amount are required");
    const { tx, round: r } = await lending.vaultDeposit(svc.asAccountName(lender), amount, round);
    logTx(tx, "vault.deposit", lender, `${lender} deposited ${amount} USDC into vault round ${r} (XLS-65 VaultDeposit)`);
    broadcast("vault", { round: r, type: "deposit", lender, amount, tx: tx.hash });
    return { round: r, tx };
  })
);

lendingRouter.post(
  "/vault/withdraw",
  handle(async (req) => {
    const { lender, amount, round } = req.body as { lender: string; amount: string; round?: number };
    if (!lender || !(Number(amount) > 0)) throw new svc.LendingError("BAD_REQUEST", "lender and a positive amount are required");
    const { tx, round: r } = await lending.vaultWithdraw(svc.asAccountName(lender), amount, round);
    logTx(tx, "vault.withdraw", lender, `${lender} withdrew ${amount} USDC from vault round ${r} (XLS-65 VaultWithdraw)`);
    broadcast("vault", { round: r, type: "withdraw", lender, amount, tx: tx.hash });
    return { round: r, tx };
  })
);

// ---------------------------------------------------------------------------
// Credit and risk reads
// ---------------------------------------------------------------------------

lendingRouter.get("/credit/stats", handle(async () => credit.getStats()));

// :address may be a demo account name (ALICE) or an XRPL address.
lendingRouter.get(
  "/credit/:network/:address",
  handle(async (req) => {
    const name = lending.nameOf(req.params.address);
    const address = req.params.address.startsWith("r") ? req.params.address : lending.addressOf(req.params.address);
    const { profile, source } = await credit.getProfile(req.params.network, address, name);
    return { ...profile, dataSource: source };
  })
);

lendingRouter.get(
  "/risk/book-stats",
  handle(async (req) => {
    const { stats, source } = await risk.bookStats(req.query.grade as string | undefined);
    return { ...stats, dataSource: source };
  })
);

// ---------------------------------------------------------------------------
// Loans (borrowers)
// ---------------------------------------------------------------------------

lendingRouter.post("/loans/quote", handle(async (req) => svc.buildQuote(req.body as LoanQuoteApiRequest)));

// The quote's Bedrock memo, written in the background. ?wait=ms long-polls up to 14 s.
lendingRouter.get(
  "/loans/quote/:id/memo",
  handle(async (req) => svc.quoteMemo(req.params.id, Math.min(14_000, Number(req.query.wait ?? 0) || 0)))
);

// { borrower, gpuId, collateralShares } -> { maxPrincipal, collateralValue, termSeconds }
lendingRouter.post("/loans/max", handle(async (req) => svc.maxApprovedPrincipal(req.body)));

lendingRouter.get("/loans", handle(async (req) => ({ loans: await svc.listLoans(req.query.borrower as string | undefined) })));

lendingRouter.get(
  "/loans/:id",
  handle(async (req, res) => {
    const rec = await svc.loanRecord(req.params.id);
    if (!rec) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown loanId" } });
      return;
    }
    return rec;
  })
);

lendingRouter.post(
  "/loans/:id/pay",
  handle(async (req) => svc.repay(req.params.id, ((req.body ?? {}) as { mode?: "full" | "next" }).mode ?? "next"))
);

// ---------------------------------------------------------------------------
// Demo controls (devnet only; never touches mainnet)
// ---------------------------------------------------------------------------

lendingRouter.post(
  "/demo/stress",
  handle(async (req) => {
    const b = req.body as { gpuId: GpuId; level?: "margin_call" | "liquidation"; shockPct?: number; loanId?: string };
    return svc.stress({ gpuId: b.gpuId ?? "gpu-a", level: b.level, shockPct: b.shockPct, loanId: b.loanId });
  })
);

lendingRouter.post(
  "/demo/stress/restore",
  handle(async (req) => svc.restorePrice(((req.body ?? {}) as { gpuId?: GpuId }).gpuId ?? "gpu-a"))
);

lendingRouter.get(
  "/health/services",
  handle(async () => ({
    network: lending.lendingNetwork(),
    lending: lending.lendingAvailable(),
    mocks: {
      MOCK_XRPL: process.env.MOCK_XRPL ?? "1",
      MOCK_COMPUTE: process.env.MOCK_COMPUTE ?? "1",
      MOCK_PRICING: process.env.MOCK_PRICING ?? "1",
      MOCK_RISK: process.env.MOCK_RISK ?? "1",
      MOCK_CREDIT: process.env.MOCK_CREDIT ?? "1",
    },
    lastSources: sources(),
    liveKeeper: await risk.liveKeeperAvailable(),
  }))
);

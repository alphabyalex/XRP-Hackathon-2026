import { Router, type Request, type Response } from "express";
import type { GpuId, LoanQuoteApiRequest } from "@moonshift/shared";
import * as lending from "../adapters/lendingAdapter.js";
import * as credit from "../adapters/creditClient.js";
import * as risk from "../adapters/riskClient.js";
import { sources } from "../adapters/serviceFetch.js";
import { logTx } from "../db/helpers.js";
import { db } from "../db/db.js";
import { broadcast } from "../sse.js";
import * as svc from "../lending/service.js";
import { requireOperator } from "../middleware/auth.js";
import { actorFor, asActor, clearedSessionCookie, cookieValue, sessionCookie } from "../middleware/session.js";
import { SESSION_COOKIE, createSession, endSession } from "../users/accounts.js";

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
      if (err instanceof svc.LendingError || (typeof err?.status === "number" && typeof err?.code === "string")) {
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

// Principal-weighted APR the round's loans pay, else the whole book's: the
// rate a lender's deposit is expected to earn when it is lent.
function weightedApr(round: number): string {
  const q = (where: string, ...args: number[]) =>
    db.prepare(`SELECT SUM(CAST(principal AS REAL) * CAST(apr AS REAL)) AS w, SUM(CAST(principal AS REAL)) AS p FROM xls_loans ${where}`).get(...args) as {
      w: number | null;
      p: number | null;
    };
  const own = q("WHERE round = ?", round);
  const book = own.p ? own : q("");
  return book.p ? ((book.w ?? 0) / book.p).toFixed(6) : "0";
}

lendingRouter.get(
  "/vault",
  handle(async () => {
    const v = await lending.vaultOverview();
    const withApy = async <T extends { round: number; assetsTotal: string; debtTotal: string }>(r: T | null) => {
      if (!r) return r;
      const apy = await risk.roundApy({ round: r.round, assets: r.assetsTotal, lentOut: r.debtTotal, weightedApr: weightedApr(r.round) });
      return { ...r, targetApyPct: (Number(apy.targetApy) * 100).toFixed(2), earnedApyPct: (Number(apy.realizedApy) * 100).toFixed(2) };
    };
    const [investing, subscribing] = await Promise.all([withApy(v.investing), withApy(v.subscribing)]);
    return { ...v, investing, subscribing };
  })
);

lendingRouter.get(
  "/vault/positions/:account",
  asActor("params", "account"),
  handle(async (req) => ({ account: req.params.account, positions: await lending.lenderPositions(svc.asAccountName(req.params.account)) }))
);

lendingRouter.post(
  "/vault/deposit",
  asActor("body", "lender"),
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
  asActor("body", "lender"),
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

// principal may be "max": the largest amount risk approves for the collateral.
lendingRouter.post("/loans/quote", asActor("body", "borrower"), handle(async (req) => svc.buildQuote(req.body as LoanQuoteApiRequest)));

// The borrower's cached credit profile on the lending network.
lendingRouter.get("/loans/profile/:borrower", asActor("params", "borrower"), handle(async (req) => svc.borrowerProfile(req.params.borrower)));

// Sign in with a wallet (Crossmark testnet): challenge, then verify the
// signature. The wallet is the user: verify looks up or creates its Moonshift
// account and sets the session cookie. There is no sign-in without a signature.
lendingRouter.post("/wallet/challenge", handle(async () => svc.walletChallenge()));
lendingRouter.post(
  "/wallet/verify",
  handle(async (req, res) => {
    const { challengeId, publicKey, signature, address } = req.body ?? {};
    if (!challengeId || !publicKey || !signature) throw new svc.LendingError("BAD_REQUEST", "challengeId, publicKey and signature are required");
    const out = await svc.walletSignIn({ challengeId, publicKey, signature, address });
    const s = createSession(out.wallet.address);
    res.setHeader("Set-Cookie", sessionCookie(s.token, s.maxAgeSeconds));
    return out;
  })
);
// Operator: give a wallet a fresh account (clean Moonshift loan history).
lendingRouter.post(
  "/operator/accounts/reset",
  requireOperator,
  handle(async (req) => {
    const wallet = String(req.body?.wallet ?? "");
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(wallet)) throw new svc.LendingError("BAD_REQUEST", "wallet must be a classic XRPL address");
    return svc.resetWalletAccount(wallet);
  })
);

// The signed-in wallet and its account (wallet: null when signed out).
lendingRouter.get("/wallet/me", handle(async (req) => svc.walletMe(req.user ?? null)));
lendingRouter.delete(
  "/wallet/me",
  handle(async (req, res) => {
    endSession(cookieValue(req, SESSION_COOKIE));
    res.setHeader("Set-Cookie", clearedSessionCookie());
    return { wallet: null };
  })
);

// The quote's Bedrock memo, written in the background. ?wait=ms long-polls up to 14 s.
lendingRouter.get(
  "/loans/quote/:id/memo",
  handle(async (req) => svc.quoteMemo(req.params.id, Math.min(14_000, Number(req.query.wait ?? 0) || 0)))
);

// { borrower, gpuId, collateralShares } -> { maxPrincipal, collateralValue, termSeconds }
lendingRouter.post("/loans/max", asActor("body", "borrower"), handle(async (req) => svc.maxApprovedPrincipal(req.body)));

// ?borrower=me: the signed-in account's loans. Without it: the public loan book.
lendingRouter.get(
  "/loans",
  handle(async (req) => ({ loans: await svc.listLoans(req.query.borrower ? actorFor(req, req.query.borrower) : undefined) }))
);

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
  handle(async (req) => svc.repay(req.params.id, ((req.body ?? {}) as { mode?: "full" | "next" }).mode ?? "next", (b) => actorFor(req, b)))
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

// The Lend and Borrow pages' read routes (contracts/api/collateral_options.json, lending_*.json,
// applications.json), built from the real vault (XLS-65 on devnet), the loan table, the tx log
// and the risk service. Nothing here is estimated or filled in: a value with no source is null.

import { Router } from "express";
import { randomUUID } from "crypto";
import { GPUS, fix6 } from "@moonshift/shared";
import * as lending from "../adapters/lendingAdapter.js";
import * as xrpl from "../adapters/xrplAdapter.js";
import { serviceJson } from "../adapters/serviceFetch.js";
import { db } from "../db/db.js";
import * as svc from "../lending/service.js";
import { actorFor } from "../middleware/session.js";
import { listedGpus } from "../gpuHealth.js";
import { sharePrice } from "../sharePrice.js";
import { handle } from "./lending.js";

export const lendingViewsRouter = Router();

const n = (v: unknown) => Number(v ?? 0);
const OPEN = new Set(["open", "margin_call"]);

// Outstanding on one loan: the ledger's live principal while it exists, else the principal while open.
function outstandingOf(l: { status: string; principal: string; ledger: { principalOutstanding: string } | null }): number {
  if (!OPEN.has(l.status)) return 0;
  return l.ledger ? n(l.ledger.principalOutstanding) : n(l.principal);
}

// GET /loans/collateral-options: every listed GPU the signed-in account holds, with what it can borrow.
lendingViewsRouter.get(
  "/loans/collateral-options",
  handle(async (req) => {
    const account = actorFor(req);
    const balances = await xrpl.getBalances(account);
    const options = [];
    for (const gpu of listedGpus()) {
      const shares = n(balances.tokens[gpu.shareCode]);
      if (!(shares > 0)) continue;
      const price = (await sharePrice(gpu.id)).price;
      const { maxPrincipal } = await svc.maxApprovedPrincipal({ borrower: account, gpuId: gpu.id, collateralShares: fix6(shares) });
      options.push({
        gpuId: gpu.id,
        label: gpu.label.replace(/\s+/, "-"),
        shares: fix6(shares),
        price,
        collateralValue: fix6(shares * n(price)),
        maxBorrow: fix6(maxPrincipal),
      });
    }
    return { options };
  })
);

// GET /lending/base-apr: the risk desk's grade A rate now (lowest LTV on its live curve), plus the
// APR of every real loan at origination.
lendingViewsRouter.get(
  "/lending/base-apr",
  handle(async () => {
    const riskUrl = process.env.RISK_URL ?? "http://localhost:7000";
    let base: number | null = null;
    let source = "risk";
    try {
      const curve = await serviceJson<{ grades: { grade: string; points: { ltv: string; apr: string }[] }[] }>("risk", `${riskUrl}/rates/curve`);
      const a = curve.grades.find((g) => g.grade === "A")?.points ?? [];
      if (a.length) base = Math.min(...a.map((p) => n(p.apr))) * 100;
    } catch {
      source = "unavailable";
    }
    const loans = db.prepare(`SELECT apr, opened_at FROM xls_loans ORDER BY opened_at`).all() as { apr: string; opened_at: string }[];
    const now = new Date().toISOString();
    const series = loans.map((l) => ({ at: l.opened_at, apr: (n(l.apr) * 100).toFixed(2) }));
    if (base !== null) series.push({ at: now, apr: base.toFixed(2) });
    return { baseAprPct: base === null ? null : base.toFixed(2), source, series, updatedAt: now };
  })
);

// Each round's real events (deposits, loans) from the tx log, newest first.
function roundHistory(round: number) {
  const rows = db
    .prepare(`SELECT kind, summary, explorer_url, created_at FROM tx_log WHERE (kind LIKE 'vault.%' OR kind = 'loan.open' OR kind = 'loan.pay') AND summary LIKE ? ORDER BY created_at DESC LIMIT 12`)
    .all(`%round ${round}%`) as { kind: string; summary: string; explorer_url: string; created_at: string }[];
  return rows.map((r) => ({ label: r.created_at.slice(0, 16).replace("T", " "), value: r.summary.replace(/\s*\(XLS-\d+ [A-Za-z]+\)/, ""), explorerUrl: r.explorer_url || null }));
}

// GET /lending/markets: one entry per vault round, from the ledger.
lendingViewsRouter.get(
  "/lending/markets",
  handle(async () => {
    const v = await lending.vaultOverview();
    const rounds = new Map<number, (typeof v.rounds)[number]>();
    for (const r of v.rounds ?? []) rounds.set(r.round, r);
    if (v.investing) rounds.set(v.investing.round, v.investing);
    if (v.subscribing) rounds.set(v.subscribing.round, v.subscribing);
    const gpus = GPUS.filter((g) => listedGpus().some((l) => l.id === g.id)).map((g) => g.label.replace(/\s+/, "-"));
    const markets = [...rounds.values()]
      .sort((a, b) => b.round - a.round)
      .map((r) => {
        const apr = n(r.targetApyPct ?? r.lenderApyPct);
        return {
          id: `round-${r.round}`,
          round: r.round,
          title: `Round ${r.round}: loans to ${gpus.join(" and ")} shareholders`,
          phase: r.phase,
          acceptsDeposits: r.phase === "subscription",
          targetApr: apr > 0 ? apr.toFixed(2) : null,
          // assetsTotal is what lenders put in; no cap is set on a round, so size is what it holds.
          size: fix6(r.assetsTotal),
          filled: fix6(r.assetsTotal),
          lentOut: fix6(r.debtTotal),
          useOfFunds: "Loans to GPU shareholders, secured by their shares",
          collateral: `${gpus.join(" and ")} shares, locked on the ledger`,
          opensAt: r.subscriptionDate,
          maturesAt: r.redemptionDate,
          explorerUrl: r.explorerUrl,
          history: roundHistory(r.round),
        };
      });
    return { markets };
  })
);

// GET /lending/loanbook: every loan, newest first, with live outstanding.
lendingViewsRouter.get(
  "/lending/loanbook",
  handle(async () => {
    const loans = await svc.listLoans();
    const rows = loans
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
      .map((l) => ({
        id: l.id,
        borrowerAddress: l.borrowerAddress,
        gpuId: l.gpuId,
        principal: fix6(l.principal),
        outstanding: fix6(outstandingOf(l)),
        apr: (n(l.apr) * 100).toFixed(2),
        ltv: l.health ? (n(l.health.ltv) <= 1 ? n(l.health.ltv) * 100 : n(l.health.ltv)).toFixed(1) : null,
        marginCallLtv: (n(l.marginCallLtv) * 100).toFixed(1),
        liquidationLtv: (n(l.liquidationLtv) * 100).toFixed(1),
        state: l.status,
        network: l.network,
        txs: l.txs,
        openedAt: l.openedAt,
      }));
    const outstandingTotal = rows.reduce((s, r) => s + n(r.outstanding), 0);
    return { outstandingTotal: fix6(outstandingTotal), loans: rows };
  })
);

// GET /lending/dashboard: totals now, and outstanding and utilization rebuilt from each loan's
// open and close times and each deposit (tx log), so the series is the book's history.
lendingViewsRouter.get(
  "/lending/dashboard",
  handle(async () => {
    const [v, loans] = await Promise.all([lending.vaultOverview(), svc.listLoans()]);
    const inv = v.investing;
    const open = loans.filter((l) => OPEN.has(l.status));
    const outstanding = open.reduce((s, l) => s + outstandingOf(l), 0);
    const assetsNow = n(inv?.assetsTotal);
    const weighted = open.reduce((s, l) => s + n(l.principal), 0);
    const weightedApr = weighted > 0 ? (open.reduce((s, l) => s + n(l.principal) * n(l.apr), 0) / weighted) * 100 : null;

    // Close time of a closed loan: the tx log entry of its last step.
    const closedAt = (l: (typeof loans)[number]): string | null => {
      if (OPEN.has(l.status)) return null;
      const hashes = Object.values(l.txs ?? {});
      if (!hashes.length) return l.liquidatedAt ?? null;
      const row = db.prepare(`SELECT MAX(created_at) AS t FROM tx_log WHERE hash IN (${hashes.map(() => "?").join(",")})`).get(...hashes) as { t: string | null };
      return row.t ?? l.liquidatedAt ?? null;
    };
    const deposits = (db.prepare(`SELECT summary, created_at FROM tx_log WHERE kind = 'vault.deposit' ORDER BY created_at`).all() as { summary: string; created_at: string }[]).map((d) => ({
      at: d.created_at,
      amount: n(/deposited ([\d.]+)/.exec(d.summary)?.[1]),
    }));
    const events = [
      ...loans.map((l) => ({ at: l.openedAt, d: n(l.principal) })),
      ...loans.map((l) => ({ at: closedAt(l), d: -n(l.principal) })).filter((e): e is { at: string; d: number } => !!e.at),
    ].sort((a, b) => a.at.localeCompare(b.at));
    let out = 0;
    const series = events.map((e) => {
      out = Math.max(0, out + e.d);
      // Assets at that time: today's assets less the deposits made after it.
      const assets = assetsNow - deposits.filter((d) => d.at > e.at).reduce((s, d) => s + d.amount, 0);
      return { at: e.at, outstanding: fix6(out), utilization: assets > 0 ? ((out / assets) * 100).toFixed(2) : null };
    });
    series.push({ at: new Date().toISOString(), outstanding: fix6(outstanding), utilization: assetsNow > 0 ? ((outstanding / assetsNow) * 100).toFixed(2) : null });

    return {
      outstanding: fix6(outstanding),
      available: fix6(inv?.assetsAvailable),
      utilization: assetsNow > 0 ? ((outstanding / assetsNow) * 100).toFixed(2) : null,
      weightedApr: weightedApr === null ? null : weightedApr.toFixed(2),
      defaults: loans.filter((l) => l.status === "liquidated" || l.status === "defaulted").length,
      marginCalls: loans.filter((l) => l.marginCallAt).length,
      cover: fix6(inv?.coverAvailable),
      series,
      updatedAt: new Date().toISOString(),
    };
  })
);

// POST /applications and GET /applications: capital and new-market requests, "Under review".
lendingViewsRouter.post(
  "/applications",
  handle(async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "market" ? "market" : b.kind === "capital" ? "capital" : null;
    const name = String(b.name ?? "").trim();
    const email = String(b.email ?? "").trim();
    const details = String(b.details ?? "").trim();
    if (!kind || !name || !/.+@.+\..+/.test(email) || details.length < 10) {
      throw new svc.LendingError("BAD_REQUEST", "name, a valid email and details are required", 400);
    }
    const id = `app_${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO applications (id, kind, name, email, company, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      kind,
      name.slice(0, 120),
      email.slice(0, 200),
      b.company ? String(b.company).slice(0, 120) : null,
      details.slice(0, 4000),
      "Under review",
      createdAt
    );
    return { id, status: "Under review", createdAt };
  })
);

lendingViewsRouter.get(
  "/applications",
  handle(async () => {
    const rows = db.prepare(`SELECT id, kind, name, company, status, created_at FROM applications ORDER BY created_at DESC LIMIT 100`).all() as any[];
    return { applications: rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, company: r.company, status: r.status, createdAt: r.created_at })) };
  })
);



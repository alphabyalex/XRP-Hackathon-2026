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
import { isLedgerHash, ledgerBalanceObservation, sampleObservations } from "../lending/verifiedHistory.js";

export const lendingViewsRouter = Router();
db.exec(`CREATE TABLE IF NOT EXISTS lending_dashboard_observations (
  network TEXT NOT NULL, round INTEGER NOT NULL, observed_at TEXT NOT NULL,
  outstanding TEXT NOT NULL, utilization TEXT, PRIMARY KEY(network,round,observed_at)
); CREATE INDEX IF NOT EXISTS lending_dashboard_observed_time ON lending_dashboard_observations(observed_at);`);

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
    const loans = await svc.listLoans();
    const now = new Date().toISOString();
    const series = loans.map((l) => ({ at: l.openedAt, apr: (n(l.apr) * 100).toFixed(2) }));
    return { baseAprPct: base === null ? null : base.toFixed(2), source, series, seriesBasis: "validated_loan_originations", updatedAt: now };
  })
);

// Each round's real events (deposits, loans) from the tx log, newest first.
async function roundHistory(round: number) {
  const rows = db.prepare(`SELECT hash, summary, explorer_url, created_at FROM tx_log WHERE (kind LIKE 'vault.%' OR kind = 'loan.open' OR kind = 'loan.pay') AND summary LIKE ? ORDER BY created_at DESC LIMIT 30`).all(`%round ${round}%`) as { hash: string; summary: string; explorer_url: string; created_at: string }[];
  const checked = await Promise.all(rows.map(async row => isLedgerHash(row.hash) && await svc.validatedHistoryTransaction(row.hash) ? row : null));
  return checked.filter((row): row is (typeof rows)[number] => row !== null).slice(0, 12)
    .map(r => ({ label: r.created_at.slice(0, 16).replace("T", " "), value: r.summary.replace(/\s*\(XLS-\d+ [A-Za-z]+\)/, ""), explorerUrl: r.explorer_url || null }));
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
    const markets = await Promise.all([...rounds.values()]
      .sort((a, b) => b.round - a.round)
      .map(async (r) => {
        const apr = n(r.targetApyPct ?? r.lenderApyPct);
        return {
          id: `round-${r.round}`,
          round: r.round,
          title: `Round ${r.round}: loans to ${gpus.join(" and ")} shareholders`,
          phase: r.phase,
          acceptsDeposits: r.phase === "subscription" &&
            (r.assetsMaximum == null || Number(r.assetsTotal) < Number(r.assetsMaximum)),
          targetApr: apr > 0 ? apr.toFixed(2) : null,
          // Deposits are not a limit. Preserve an unlimited ledger vault as null.
          size: r.assetsMaximum ?? null,
          filled: fix6(r.assetsTotal),
          lentOut: fix6(r.debtTotal),
          useOfFunds: "Loans to GPU shareholders, secured by their shares",
          collateral: `${gpus.join(" and ")} shares, locked on the ledger`,
          opensAt: r.subscriptionDate,
          maturesAt: r.redemptionDate,
          explorerUrl: r.explorerUrl,
          history: await roundHistory(r.round),
        };
      }));
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
        simulated: l.simulated,
        originValidated: !l.simulated,
      }));
    const outstandingTotal = rows.reduce((s, r) => s + n(r.outstanding), 0);
    return { outstandingTotal: fix6(outstandingTotal), loans: rows };
  })
);

// Observed balances of the actual lending round. Sparse history stays sparse.
lendingViewsRouter.get(
  "/lending/dashboard",
  handle(async () => {
    const [v, loans] = await Promise.all([lending.vaultOverview(), svc.listLoans()]);
    const inv = v.investing;
    const open = loans.filter(l => OPEN.has(l.status));
    const balance = ledgerBalanceObservation(v);
    const outstanding = balance?.outstanding ?? null;
    const weighted = open.reduce((sum, loan) => sum + n(loan.principal), 0);
    const weightedApr = weighted > 0 ? open.reduce((sum, loan) => sum + n(loan.principal) * n(loan.apr), 0) / weighted * 100 : null;
    const observedAt = new Date().toISOString();
    const utilization = balance?.utilization?.toFixed(2) ?? null;
    if (balance && inv && outstanding !== null) {
      db.prepare(`INSERT OR IGNORE INTO lending_dashboard_observations (network,round,observed_at,outstanding,utilization) VALUES (?,?,?,?,?)`)
        .run(v.network, inv.round, observedAt, fix6(outstanding), utilization);
    }
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const observations = inv && !v.simulated ? db.prepare(`SELECT observed_at AS at,outstanding,utilization FROM lending_dashboard_observations WHERE network=? AND round=? AND observed_at>=? ORDER BY observed_at`)
      .all(v.network, inv.round, since) as { at: string; outstanding: string; utilization: string | null }[] : [];
    db.prepare("DELETE FROM lending_dashboard_observations WHERE observed_at<?").run(since);
    return {
      outstanding: outstanding === null ? null : fix6(outstanding),
      available: balance ? fix6(balance.available) : null,
      utilization,
      weightedApr: weightedApr === null ? null : weightedApr.toFixed(2),
      defaults: loans.filter(l => l.status === "liquidated" || l.status === "defaulted").length,
      marginCalls: loans.filter(l => l.marginCallAt).length,
      cover: balance ? fix6(balance.cover) : null,
      series: sampleObservations(observations),
      seriesBasis: "observed_ledger_balances", verifiedLoanHistory: !v.simulated,
      updatedAt: observedAt,
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

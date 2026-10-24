// Lending orchestration for apps/api: quote (credit + revenue + oracle ->
// risk -> Bedrock memo), open/repay XLS-66 loans, loan health, margin calls
// and liquidations (idempotent, callable by Kristian's keeper or the
// built-in keeper), the demo stress control, and the background defaulter.

import { randomUUID } from "crypto";
import {
  GPUS,
  explorerUrl,
  fix6,
  pctToTenthBps,
  type AccountName,
  type AgentText,
  type GpuId,
  type KeeperActionBody,
  type KeeperLoan,
  type LoanQuoteApiRequest,
  type LoanQuoteApiResponse,
  type PricePoint,
  type StressResult,
  type TxResult,
  type XlsLoanRecord,
  type XlsLoanStatus,
} from "@moonshift/shared";
import { db } from "../db/db.js";
import { logTx } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import * as lending from "../adapters/lendingAdapter.js";
import * as credit from "../adapters/creditClient.js";
import * as risk from "../adapters/riskClient.js";
import * as pricing from "../adapters/pricingClient.js";
import * as compute from "../adapters/computeClient.js";

export class LendingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

// Demo loan defaults. Risk's model sizes max LTV by dividend coverage over
// the term, so a 10 minute loan can barely borrow anything; 30 days is the
// product default. The schedule is capped near 30 installments so a demo loan
// is not "late" every minute (decision logged in docs/status/alex.md).
export const DEFAULT_TERM_SECONDS = Number(process.env.LOAN_TERM_SECONDS ?? 30 * 86400);
const MAX_INSTALLMENTS = Number(process.env.LOAN_MAX_INSTALLMENTS ?? 30);
const GRACE_SECONDS = Number(process.env.LOAN_GRACE_SECONDS ?? 60);
const QUOTE_TTL_SECONDS = 300;
const CREDIT_NETWORK = () => process.env.CREDIT_NETWORK ?? (lending.MOCK ? "testnet" : lending.lendingNetwork());

// ---------------------------------------------------------------------------
// Oracle history (also served to the keeper at /internal/oracle/:gpuId/history)
// ---------------------------------------------------------------------------

export function recordOracle(gpuId: string, price: string, source: string, txHash: string | null = null): void {
  db.prepare(`INSERT OR REPLACE INTO oracle_history (gpu_id, ts, price, source, tx_hash) VALUES (?, ?, ?, ?, ?)`).run(
    gpuId,
    new Date().toISOString(),
    fix6(price),
    source,
    txHash
  );
}

export function oracleHistory(gpuId: string, from?: string, to?: string): PricePoint[] {
  const rows = db
    .prepare(`SELECT ts, price FROM oracle_history WHERE gpu_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`)
    .all(gpuId, from ?? "1970-01-01", to ?? "9999-12-31") as { ts: string; price: string }[];
  return rows.map((r) => ({ timestamp: r.ts, price: r.price }));
}

async function collateralPrice(gpuId: GpuId) {
  const o = await lending.oraclePrice(gpuId);
  const hist = oracleHistory(gpuId, new Date(Date.now() - 7 * 86400e3).toISOString());
  if (!hist.length || hist[hist.length - 1].price !== o.price) recordOracle(gpuId, o.price, o.source === "live" ? "ledger" : "mock");
  const history = oracleHistory(gpuId, new Date(Date.now() - 7 * 86400e3).toISOString());
  return { price: o.price, history: history.length >= 2 ? history : [{ timestamp: new Date(Date.now() - 3600e3).toISOString(), price: o.price }, { timestamp: new Date().toISOString(), price: o.price }], source: o.source };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export function xls66Terms(termSeconds: number, riskInterval: number, aprFraction: number) {
  const interval = Math.max(60, riskInterval, Math.ceil(termSeconds / MAX_INSTALLMENTS));
  return {
    interestRateTenthBps: Math.round(aprFraction * 100000), // 0.0908 -> 9080
    paymentTotal: Math.max(1, Math.ceil(termSeconds / interval)),
    paymentIntervalSeconds: interval,
    gracePeriodSeconds: GRACE_SECONDS,
    termSeconds,
  };
}

export async function buildQuote(req: LoanQuoteApiRequest): Promise<LoanQuoteApiResponse> {
  const gpu = GPUS.find((g) => g.id === req.gpuId);
  if (!gpu) throw new LendingError("BAD_REQUEST", `unknown gpuId ${req.gpuId}`);
  if (!(Number(req.collateralShares) > 0) || !(Number(req.principal) > 0)) {
    throw new LendingError("BAD_REQUEST", "collateralShares and principal must be positive");
  }
  const name = lending.nameOf(req.borrower);
  const address = lending.addressOf(req.borrower);
  // A loan must mature before its vault round's redemption date (the ledger
  // rejects LoanSet with tecNO_PERMISSION otherwise), so cap the term.
  const round = (await lending.vaultOverview()).investing;
  if (!round) throw new LendingError("NO_LENDING_ROUND", "no vault round is lending right now; run npm run demo:reset", 409);
  const roundLeft = Math.floor((new Date(round.redemptionDate).getTime() - Date.now()) / 1000) - 3 * 3600;
  const termSeconds = Math.max(120, Math.min(Math.floor(req.termSeconds ?? DEFAULT_TERM_SECONDS), roundLeft));

  const [{ profile, source: creditSource }, oracle, nav] = await Promise.all([
    credit.getProfile(CREDIT_NETWORK(), address, name),
    collateralPrice(gpu.id),
    pricing.getNav(gpu.id).catch(() => null),
  ]);
  const revenue24h = Number(nav?.trailing_revenue_24h ?? 48.2);
  const { buckets, source: revenueSource } = await compute.getRevenueHistory(gpu.id, 24, revenue24h);

  const riskReq = {
    borrower: address,
    gpuId: gpu.id,
    collateralShares: fix6(req.collateralShares),
    principal: fix6(req.principal),
    termSeconds,
    creditProfile: credit.toRiskProfile(profile),
    revenueHistory: buckets,
    collateralPrice: oracle.price,
    collateralPriceHistory: oracle.history,
  };
  const { quote, source: riskSource } = await risk.quote(riskReq);
  const memo = await pricing.creditMemo({
    creditProfile: { address, network: profile.network, score: profile.score, grade: profile.grade, confidence: profile.confidence, features: profile.features, reasons: profile.reasons },
    quote,
    loanRequest: { borrower: address, gpuId: gpu.id, collateralShares: riskReq.collateralShares, principal: riskReq.principal, termSeconds },
  });

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
  const out: LoanQuoteApiResponse = {
    quoteId,
    expiresAt,
    borrower: name ?? req.borrower,
    borrowerAddress: address,
    gpuId: gpu.id,
    collateralShares: riskReq.collateralShares,
    principal: riskReq.principal,
    collateralPrice: oracle.price,
    collateralValue: fix6(Number(req.collateralShares) * Number(oracle.price)),
    quote,
    terms: xls66Terms(termSeconds, quote.paymentIntervalSeconds, Number(quote.apr)),
    credit: profile,
    memo,
    revenue24h: fix6(buckets.reduce((s, b) => s + Number(b.revenue), 0)),
    sources: { credit: creditSource, risk: riskSource, memo: memo.source, revenue: revenueSource, oracle: oracle.source === "live" ? "live" : "mock" },
  };
  db.prepare(`INSERT INTO loan_quotes (id, created_at, expires_at, body, used) VALUES (?, ?, ?, ?, 0)`).run(quoteId, new Date().toISOString(), expiresAt, JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------------------
// Loan records
// ---------------------------------------------------------------------------

function rowToRecord(row: any) {
  return {
    id: row.id as string,
    network: row.network as string,
    borrower: row.borrower as string,
    borrowerAddress: row.borrower_address as string,
    gpuId: row.gpu_id as string,
    collateralShares: row.collateral_shares as string,
    principal: row.principal as string,
    apr: row.apr as string,
    marginCallLtv: row.margin_call_ltv as string,
    liquidationLtv: row.liquidation_ltv as string,
    pd: row.pd as string,
    status: row.status as XlsLoanStatus,
    openedAt: row.opened_at as string,
    marginCallAt: (row.margin_call_at as string) ?? null,
    liquidatedAt: (row.liquidated_at as string) ?? null,
    round: Number(row.round),
    txs: JSON.parse(row.txs || "{}") as Record<string, string>,
    simulated: Boolean(row.simulated),
    defaultEligibleAt: (row.default_eligible_at as string) ?? null,
  };
}

function getRow(id: string) {
  const row = db.prepare(`SELECT * FROM xls_loans WHERE id = ?`).get(id);
  return row ? rowToRecord(row) : null;
}

function addTx(id: string, step: string, tx: TxResult | null | undefined) {
  if (!tx?.hash) return;
  const r = getRow(id);
  if (!r) return;
  r.txs[step] = tx.hash;
  db.prepare(`UPDATE xls_loans SET txs = ? WHERE id = ?`).run(JSON.stringify(r.txs), id);
}

function setStatus(id: string, status: XlsLoanStatus, extra: Record<string, string | null> = {}) {
  const sets = ["status = ?", ...Object.keys(extra).map((k) => `${k} = ?`)].join(", ");
  db.prepare(`UPDATE xls_loans SET ${sets} WHERE id = ?`).run(status, ...Object.values(extra), id);
}

export async function loanRecord(id: string): Promise<XlsLoanRecord | null> {
  const r = getRow(id);
  if (!r) return null;
  const ledger = await lending.getLoan(id).catch(() => null);
  const { price } = await lending.oraclePrice(r.gpuId as GpuId);
  const outstanding = ledger ? Number(ledger.totalValueOutstanding) : 0;
  const cv = Number(r.collateralShares) * Number(price);
  const { defaultEligibleAt: _d, ...rest } = r;
  return {
    ...rest,
    ledger,
    health: ledger && outstanding > 0 ? { collateralPrice: price, collateralValue: fix6(cv), ltv: (cv > 0 ? outstanding / cv : 99).toFixed(6) } : null,
  };
}

export async function listLoans(borrower?: string): Promise<XlsLoanRecord[]> {
  const rows = borrower
    ? (db.prepare(`SELECT id FROM xls_loans WHERE borrower = ? OR borrower_address = ? ORDER BY opened_at DESC`).all(borrower, borrower) as { id: string }[])
    : (db.prepare(`SELECT id FROM xls_loans ORDER BY opened_at DESC`).all() as { id: string }[]);
  const out: XlsLoanRecord[] = [];
  for (const { id } of rows) {
    const rec = await loanRecord(id);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Open and repay
// ---------------------------------------------------------------------------

export async function openFromQuote(quoteId: string): Promise<XlsLoanRecord> {
  const qrow = db.prepare(`SELECT * FROM loan_quotes WHERE id = ?`).get(quoteId) as any;
  if (!qrow) throw new LendingError("QUOTE_NOT_FOUND", "unknown quoteId; request a new quote", 404);
  if (qrow.used) throw new LendingError("QUOTE_USED", "this quote already opened a loan", 409);
  if (new Date(qrow.expires_at).getTime() < Date.now()) throw new LendingError("QUOTE_EXPIRED", "quote expired; request a new one", 409);
  const q = JSON.parse(qrow.body) as LoanQuoteApiResponse;
  if (q.quote.decision !== "approve") throw new LendingError("QUOTE_DECLINED", `risk declined this loan: ${q.quote.reasons.join(", ") || "LTV above max"}`, 409);
  const name = lending.nameOf(q.borrower);
  if (!name) throw new LendingError("BORROWER_NOT_CONFIGURED", "borrower must be a demo account that can countersign", 400);

  db.prepare(`UPDATE loan_quotes SET used = 1 WHERE id = ?`).run(quoteId);
  let opened;
  try {
    opened = await lending.openLoan({
      borrower: name,
      gpuId: q.gpuId as GpuId,
      collateralShares: q.collateralShares,
      principal: q.principal,
      aprPct: Number(q.quote.apr) * 100,
      termSeconds: q.terms.termSeconds,
      paymentIntervalSeconds: q.terms.paymentIntervalSeconds,
      gracePeriodSeconds: q.terms.gracePeriodSeconds,
    });
  } catch (e) {
    db.prepare(`UPDATE loan_quotes SET used = 0 WHERE id = ?`).run(quoteId);
    const msg = (e as Error).message;
    if (/tecUNFUNDED|tecINSUFFICIENT|tecPATH_DRY|tecNO_LINE/.test(msg)) {
      throw new LendingError("INSUFFICIENT_COLLATERAL", `Not enough ${q.gpuId.toUpperCase()} shares to lock ${q.collateralShares} as collateral (${msg})`, 409);
    }
    throw e;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO xls_loans (id, network, borrower, borrower_address, gpu_id, collateral_shares, principal, apr, margin_call_ltv, liquidation_ltv, pd, round, status, opened_at, txs, quote_id, simulated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(
    opened.loanId,
    lending.lendingNetwork(),
    name,
    q.borrowerAddress,
    q.gpuId,
    q.collateralShares,
    q.principal,
    q.quote.apr,
    q.quote.marginCallLtv,
    q.quote.liquidationLtv,
    q.quote.pd,
    opened.round,
    now,
    JSON.stringify({ escrow: opened.escrowTx.hash, loanSet: opened.loanSetTx.hash }),
    quoteId,
    lending.MOCK ? 1 : 0
  );
  logTx(opened.escrowTx as TxResult, "loan.escrow", name, `${name} escrowed ${q.collateralShares} ${q.gpuId.toUpperCase()} shares as collateral`);
  logTx(opened.loanSetTx as TxResult, "loan.open", name, `${name} borrowed ${q.principal} USDC from vault round ${opened.round} (XLS-66 LoanSet)`);
  broadcast("loan", { id: opened.loanId, type: "opened", status: "open", borrower: name, txs: { escrow: opened.escrowTx.hash, loanSet: opened.loanSetTx.hash } });
  broadcast("vault", { round: opened.round });

  const ledger = opened.loan;
  void credit.watch(CREDIT_NETWORK(), q.borrowerAddress, [
    { loanId: opened.loanId, dueAt: ledger?.nextPaymentDueDate ?? new Date(Date.now() + q.terms.paymentIntervalSeconds * 1000).toISOString(), principal: q.principal },
  ]);
  return (await loanRecord(opened.loanId))!;
}

export async function repay(id: string, mode: "full" | "next" = "full"): Promise<XlsLoanRecord> {
  const r = getRow(id);
  if (!r) throw new LendingError("NOT_FOUND", "unknown loanId", 404);
  if (r.status === "repaid" || r.status === "liquidated" || r.status === "defaulted") {
    throw new LendingError("ALREADY_SETTLED", `loan is already ${r.status}`, 409);
  }
  const res = await lending.repay(id, mode);
  res.payments.forEach((t, i) => addTx(id, i === 0 ? "pay" : `pay${i + 1}`, t as TxResult));
  addTx(id, "release", res.releaseTx as TxResult);
  addTx(id, "delete", res.deleteTx as TxResult);
  for (const t of res.payments) logTx(t as TxResult, "loan.pay", r.borrower, `${r.borrower} paid loan ${id.slice(0, 8)} (XLS-66 LoanPay)`);
  if (res.releaseTx) logTx(res.releaseTx as TxResult, "loan.release", r.borrower, `collateral returned to ${r.borrower} (Batch EscrowFinish + Payment)`);
  if (res.paidOff) setStatus(id, "repaid");
  broadcast("loan", { id, type: res.paidOff ? "repaid" : "paid", status: res.paidOff ? "repaid" : r.status, txs: { pay: res.hash, release: res.releaseTx?.hash ?? null } });
  broadcast("vault", { round: r.round });
  return (await loanRecord(id))!;
}

// ---------------------------------------------------------------------------
// Keeper surface (idempotent)
// ---------------------------------------------------------------------------

export async function keeperLoans(): Promise<KeeperLoan[]> {
  const rows = db.prepare(`SELECT * FROM xls_loans WHERE status IN ('open','margin_call')`).all().map(rowToRecord);
  const out: KeeperLoan[] = [];
  for (const r of rows) {
    const ledger = await lending.getLoan(r.id).catch(() => null);
    if (!ledger || Number(ledger.totalValueOutstanding) <= 0) continue;
    out.push({
      loanId: r.id,
      borrower: r.borrowerAddress,
      gpuId: r.gpuId,
      collateralShares: r.collateralShares,
      outstandingBalance: fix6(ledger.totalValueOutstanding),
      apr: r.apr,
      pd: r.pd,
      status: r.status,
      marginCallLtv: r.marginCallLtv,
      liquidationLtv: r.liquidationLtv,
      marginCallAt: r.marginCallAt,
      simulated: r.simulated,
    });
  }
  return out;
}

function priorAction(key: string) {
  return db.prepare(`SELECT * FROM keeper_actions WHERE idempotency_key = ?`).get(key) as any;
}

function saveAction(key: string, loanId: string, action: string, tx: TxResult | null, body: unknown) {
  db.prepare(`INSERT OR IGNORE INTO keeper_actions (idempotency_key, loan_id, action, tx_hash, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    key,
    loanId,
    action,
    tx?.hash ?? null,
    JSON.stringify(body),
    new Date().toISOString()
  );
}

async function alertFor(type: "margin_call" | "liquidation", r: ReturnType<typeof rowToRecord>, ltv: string): Promise<AgentText> {
  const ledger = await lending.getLoan(r.id).catch(() => null);
  const { price } = await lending.oraclePrice(r.gpuId as GpuId);
  return pricing.riskAlert({
    type,
    loanId: r.id,
    borrower: r.borrowerAddress,
    gpuId: r.gpuId,
    ltv,
    thresholdLtv: r.marginCallLtv,
    liquidationLtv: r.liquidationLtv,
    outstandingBalance: fix6(ledger?.totalValueOutstanding ?? r.principal),
    collateralValue: fix6(Number(r.collateralShares) * Number(price)),
    reason: type === "margin_call" ? "MARGIN_CALL_THRESHOLD_CROSSED" : "LIQUIDATION_THRESHOLD_CROSSED",
  });
}

// One keeper action per loan at a time: the background keeper, a stress run
// and Kristian's keeper can all fire on the same price move.
const loanLocks = new Map<string, Promise<unknown>>();
function withLoanLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = loanLocks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  loanLocks.set(id, next.catch(() => {}));
  return next;
}

export function marginCall(id: string, body: KeeperActionBody, via: string) {
  return withLoanLock(id, () => marginCallLocked(id, body, via));
}

export function liquidate(id: string, body: KeeperActionBody, via: string) {
  return withLoanLock(id, () => liquidateLocked(id, body, via));
}

async function marginCallLocked(id: string, body: KeeperActionBody, via: string) {
  const prior = priorAction(body.idempotencyKey);
  if (prior) return { loanId: id, idempotent: true, txHash: prior.tx_hash as string | null };
  const r = getRow(id);
  if (!r) throw new LendingError("NOT_FOUND", "unknown loanId", 404);
  if (r.status !== "open") {
    saveAction(body.idempotencyKey, id, "margin_call", null, body);
    return { loanId: id, idempotent: true, txHash: r.txs.marginCall ?? null, status: r.status };
  }
  const tx = await lending.marginCall(id, body.observedLtv, body.threshold, body.reason);
  saveAction(body.idempotencyKey, id, "margin_call", tx, body);
  addTx(id, "marginCall", tx);
  setStatus(id, "margin_call", { margin_call_at: body.occurredAt || new Date().toISOString() });
  logTx(tx, "loan.margin_call", r.borrower, `margin call on loan ${id.slice(0, 8)} at ${(Number(body.observedLtv) * 100).toFixed(1)}% LTV (${via})`);
  const alert = await alertFor("margin_call", r, body.observedLtv);
  broadcast("loan", { id, type: "margin_call", status: "margin_call", ltv: body.observedLtv, threshold: body.threshold, tx: tx.hash, alert, via });
  return { loanId: id, idempotent: false, txHash: tx.hash, tx, alert };
}

async function liquidateLocked(id: string, body: KeeperActionBody, via: string) {
  const prior = priorAction(body.idempotencyKey);
  if (prior) return { loanId: id, idempotent: true, txHash: prior.tx_hash as string | null };
  const r = getRow(id);
  if (!r) throw new LendingError("NOT_FOUND", "unknown loanId", 404);
  if (r.status === "liquidated" || r.status === "defaulted" || r.status === "repaid") {
    saveAction(body.idempotencyKey, id, "liquidate", null, body);
    return { loanId: id, idempotent: true, txHash: r.txs.seize ?? null, status: r.status };
  }
  const res = await lending.liquidate(id, body.reason || "LTV_ABOVE_LIQUIDATION");
  const tx = (res.seizeTx ?? res.defaultTx) as TxResult | null;
  saveAction(body.idempotencyKey, id, "liquidate", tx, body);
  addTx(id, "seize", res.seizeTx as TxResult);
  addTx(id, "default", res.defaultTx as TxResult);
  setStatus(id, res.defaulted ? "defaulted" : "liquidated", {
    liquidated_at: body.occurredAt || new Date().toISOString(),
    default_eligible_at: res.defaultEligibleAt,
  });
  if (res.seizeTx) logTx(res.seizeTx as TxResult, "loan.liquidate", r.borrower, `collateral seized on loan ${id.slice(0, 8)} at ${(Number(body.observedLtv) * 100).toFixed(1)}% LTV (${via})`);
  if (res.defaultTx) logTx(res.defaultTx as TxResult, "loan.default", r.borrower, `loan ${id.slice(0, 8)} defaulted on the XLS-66 ledger`);
  const alert = await alertFor("liquidation", r, body.observedLtv);
  broadcast("loan", { id, type: "liquidated", status: res.defaulted ? "defaulted" : "liquidated", ltv: body.observedLtv, tx: tx?.hash ?? null, defaultEligibleAt: res.defaultEligibleAt, alert, via });
  broadcast("vault", { round: r.round });
  return { loanId: id, idempotent: false, txHash: tx?.hash ?? null, tx, alert, defaultEligibleAt: res.defaultEligibleAt, defaulted: res.defaulted };
}

// The api's own keeper: used whenever Kristian's keeper is not running (Python
// missing, MOCK_RISK=1) and right after a stress shock.
// A tx for the response: the new one, or the one an earlier actor already sent.
function actionTx(res: any): TxResult | null {
  if (res?.tx) return res.tx as TxResult;
  if (res?.txHash) return { hash: res.txHash, result: "tesSUCCESS", validated: true, explorerUrl: explorerUrl(res.txHash) };
  return null;
}

export async function builtInKeeperCheck(via = "api-keeper", onlyLoan?: string) {
  const actions: StressResult["actions"] = [];
  for (const l of await keeperLoans()) {
    if (onlyLoan && l.loanId !== onlyLoan) continue;
    const { price } = await lending.oraclePrice(l.gpuId as GpuId);
    const cv = Number(l.collateralShares) * Number(price);
    const ltv = cv > 0 ? Number(l.outstandingBalance) / cv : 99;
    const ltvStr = ltv.toFixed(6);
    const at = new Date().toISOString();
    if (ltv >= Number(l.liquidationLtv)) {
      const res = await liquidate(l.loanId, { idempotencyKey: `${via}:liq:${l.loanId}`, observedLtv: ltvStr, threshold: l.liquidationLtv, occurredAt: at, reason: "LIQUIDATION_THRESHOLD_CROSSED" }, via);
      actions.push({ loanId: l.loanId, action: "liquidate", ltv: ltvStr, tx: actionTx(res), alert: (res as any).alert });
    } else if (ltv >= Number(l.marginCallLtv) && l.status === "open") {
      const res = await marginCall(l.loanId, { idempotencyKey: `${via}:mc:${l.loanId}:${Math.floor(Date.now() / 600000)}`, observedLtv: ltvStr, threshold: l.marginCallLtv, occurredAt: at, reason: "MARGIN_CALL_THRESHOLD_CROSSED" }, via);
      actions.push({ loanId: l.loanId, action: "margin_call", ltv: ltvStr, tx: actionTx(res), alert: (res as any).alert });
    }
  }
  return actions;
}

// Background: default liquidated loans on the XLS-66 ledger once due date +
// grace has passed (the ledger refuses earlier).
export async function defaulterTick(): Promise<void> {
  const rows = db.prepare(`SELECT * FROM xls_loans WHERE status = 'liquidated'`).all().map(rowToRecord);
  for (const r of rows) {
    if (r.defaultEligibleAt && Date.now() < new Date(r.defaultEligibleAt).getTime()) continue;
    const tx = await lending.defaultLoan(r.id).catch(() => null);
    const ledger = await lending.getLoan(r.id).catch(() => null);
    if (tx || ledger?.state === "defaulted") {
      addTx(r.id, "default", tx);
      setStatus(r.id, "defaulted");
      if (tx) logTx(tx, "loan.default", r.borrower, `loan ${r.id.slice(0, 8)} defaulted on the XLS-66 ledger`);
      broadcast("loan", { id: r.id, type: "defaulted", status: "defaulted", tx: tx?.hash ?? null });
      broadcast("vault", { round: r.round });
    }
  }
}

// ---------------------------------------------------------------------------
// Stress: shock the on-ledger oracle, run the risk scenario, fire the keeper
// ---------------------------------------------------------------------------

const preStressPrice = new Map<string, string>();

// While a stress run is shocking the oracle, the background keeper waits, so
// the run reports the margin call or liquidation it caused.
let stressing = 0;
export function isStressing(): boolean {
  return stressing > 0;
}

export async function stress(p: Parameters<typeof stressRun>[0]): Promise<StressResult> {
  stressing++;
  try {
    return await stressRun(p);
  } finally {
    stressing--;
  }
}

async function stressRun(p: { gpuId: GpuId; level?: "margin_call" | "liquidation"; shockPct?: number; loanId?: string }): Promise<StressResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new LendingError("BAD_REQUEST", `unknown gpuId ${p.gpuId}`);
  const before = (await lending.oraclePrice(gpu.id)).price;
  if (!preStressPrice.has(gpu.id)) preStressPrice.set(gpu.id, before);

  let target = Number(before);
  let targetId = p.loanId;
  if (p.shockPct !== undefined) {
    target = Number(before) * (1 + p.shockPct / 100);
  } else {
    // Aim the price at one live loan so the demo lands on the right line.
    const book = (await keeperLoans()).filter((l) => l.gpuId === gpu.id);
    const loan = book.find((l) => l.loanId === p.loanId) ?? book[0];
    if (!loan) throw new LendingError("NO_OPEN_LOAN", `no open loan on ${gpu.id} to stress`, 409);
    targetId = loan.loanId;
    const mc = Number(loan.marginCallLtv);
    const liq = Number(loan.liquidationLtv);
    const ltvTarget = p.level === "liquidation" ? Math.min(0.99, liq + 0.05) : (mc + liq) / 2;
    target = Number(loan.outstandingBalance) / (ltvTarget * Number(loan.collateralShares));
  }
  target = Math.max(0.000001, target);
  const oracleTx = await lending.publishPrice(gpu.id, fix6(target));
  recordOracle(gpu.id, fix6(target), "stress", oracleTx.hash);
  logTx(oracleTx, "oracle.stress", "ORACLE", `stress test: ${gpu.id.toUpperCase()} oracle price ${before} -> ${fix6(target)}`);
  broadcast("risk", { type: "price_shock", gpuId: gpu.id, priceBefore: before, priceAfter: fix6(target), tx: oracleTx.hash });

  const shockPct = (target / Number(before) - 1) * 100;
  const book = await keeperLoans();
  const overview = await lending.vaultOverview();
  const inv = overview.investing;
  const { result: scenario } = await risk.runScenario({ gpuPriceShockPct: shockPct }, () =>
    risk.localScenario(
      { gpuPriceShockPct: shockPct },
      book
        .filter((l) => l.gpuId === gpu.id)
        .map((l) => ({
          loanId: l.loanId,
          outstanding: Number(l.outstandingBalance),
          collateralValue: Number(l.collateralShares) * Number(before),
          marginCallLtv: Number(l.marginCallLtv),
          liquidationLtv: Number(l.liquidationLtv),
        })),
      { assetsTotal: Number(inv?.assetsTotal ?? 0), cover: Number(inv?.coverAvailable ?? 0), aprPct: 9, utilization: Number(inv?.utilizationPct ?? 0) / 100 }
    )
  );
  const actions = await builtInKeeperCheck("stress-test");
  // If another keeper acted on the target loan in the same instant, report
  // what it did (from the loan record) so the demo shows the tx either way.
  const row = targetId ? getRow(targetId) : null;
  if (row && !actions.some((a) => a.loanId === row.id)) {
    const cv = Number(row.collateralShares) * target;
    const ledger = await lending.getLoan(row.id).catch(() => null);
    const ltv = cv > 0 ? (Number(ledger?.totalValueOutstanding ?? row.principal) / cv).toFixed(6) : "0";
    if ((row.status === "liquidated" || row.status === "defaulted") && row.txs.seize) {
      actions.push({ loanId: row.id, action: "liquidate", ltv, tx: actionTx({ txHash: row.txs.seize }) });
    } else if (row.status === "margin_call" && row.txs.marginCall && p.level !== "liquidation") {
      actions.push({ loanId: row.id, action: "margin_call", ltv, tx: actionTx({ txHash: row.txs.marginCall }) });
    }
  }
  return { gpuId: gpu.id, priceBefore: before, priceAfter: fix6(target), oracleTx, scenario, actions };
}

export async function restorePrice(gpuId: GpuId): Promise<{ price: string; tx: TxResult }> {
  const price = preStressPrice.get(gpuId) ?? "5.250000";
  const tx = await lending.publishPrice(gpuId, price);
  recordOracle(gpuId, price, "restore", tx.hash);
  preStressPrice.delete(gpuId);
  broadcast("risk", { type: "price_restore", gpuId, price, tx: tx.hash });
  return { price, tx };
}

export function asAccountName(s: string): AccountName {
  return (lending.nameOf(s) ?? s) as AccountName;
}

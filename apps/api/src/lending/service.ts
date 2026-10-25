// Lending orchestration for apps/api: quote (credit + revenue + oracle ->
// risk -> Bedrock memo), open/repay XLS-66 loans, loan health, margin calls
// and liquidations (idempotent, callable by Kristian's keeper or the
// built-in keeper), the demo stress control, and the background defaulter.

import { createHash, randomUUID } from "crypto";
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
import { swr, timed } from "./swr.js";
import { ServiceUnavailable } from "../adapters/serviceFetch.js";
import { accountForWallet, resetAccountForWallet, userForWallet, type UserAccount } from "../users/accounts.js";

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

// Quotes read the oracle through a 5 s cache; stress and restore drop it.
const oracleCache = swr<Awaited<ReturnType<typeof lending.oraclePrice>>>("oracle", 5_000, 5_000);

async function collateralPrice(gpuId: GpuId) {
  const o = await oracleCache.get(gpuId, () => lending.oraclePrice(gpuId));
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

// The borrower's credit profile on its own (cached), so /borrow can show the
// score before the quote is back.
export async function borrowerProfile(borrower: string) {
  const { profile, source } = await credit.getProfile(CREDIT_NETWORK(), lending.addressOf(borrower), lending.nameOf(borrower));
  return { ...profile, dataSource: source };
}

// A loan must mature before its vault round's redemption date (the ledger
// rejects LoanSet with tecNO_PERMISSION otherwise), so cap the term. The cap
// is rounded down to the hour: a term that moved every second made every
// quote (and its memo cache key) unique.
async function lendingTerm(requested?: number) {
  const round = (await timed("vault", lending.vaultOverview())).investing;
  if (!round) throw new LendingError("NO_LENDING_ROUND", "No vault round is lending right now. The next round opens shortly.", 409);
  const roundLeft = Math.floor((new Date(round.redemptionDate).getTime() - Date.now()) / 1000) - 3 * 3600;
  const termSeconds = Math.max(120, Math.min(Math.floor(requested ?? DEFAULT_TERM_SECONDS), Math.floor(roundLeft / 3600) * 3600));
  return { round, termSeconds };
}

// Everything risk needs besides the principal, read in parallel.
async function riskInputs(gpuId: GpuId, address: string, name: AccountName | undefined) {
  const [{ profile, source: creditSource }, oracle, nav] = await Promise.all([
    timed("credit profile", credit.getProfile(CREDIT_NETWORK(), address, name)),
    timed("oracle", collateralPrice(gpuId)),
    timed("nav", pricing.getNav(gpuId).catch(() => null)),
  ]);
  const revenue24h = Number(nav?.trailing_revenue_24h ?? 48.2);
  const { buckets, source: revenueSource } = await timed("revenue", compute.getRevenueHistory(gpuId, 24, revenue24h));
  return { profile, creditSource, oracle, buckets, revenueSource };
}

export async function buildQuote(req: LoanQuoteApiRequest): Promise<LoanQuoteApiResponse> {
  const gpu = GPUS.find((g) => g.id === req.gpuId);
  if (!gpu) throw new LendingError("BAD_REQUEST", `unknown gpuId ${req.gpuId}`);
  // principal "max": quote the largest amount risk approves (what /borrow opens on).
  if (req.principal === "max" && Number(req.collateralShares) > 0) {
    const { maxPrincipal } = await timed("max", maxApprovedPrincipal(req));
    req = { ...req, principal: Number(maxPrincipal) > 0 ? maxPrincipal : "1.00" };
  }
  if (!(Number(req.collateralShares) > 0) || !(Number(req.principal) > 0)) {
    throw new LendingError("BAD_REQUEST", "collateralShares and principal must be positive");
  }
  const name = lending.nameOf(req.borrower);
  const address = lending.addressOf(req.borrower);
  const [{ termSeconds }, { profile, creditSource, oracle, buckets, revenueSource }] = await Promise.all([
    lendingTerm(req.termSeconds),
    riskInputs(gpu.id, address, name),
  ]);

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
  let { quote, source: riskSource } = await timed("risk quote", risk.quote(riskReq));
  // Only grade E declines. Above what risk approves, a grade A-D borrower is
  // offered the largest approved amount instead of a decline (a thin wallet
  // gets a smaller loan, not a flat no).
  let counterOffer: LoanQuoteApiResponse["counterOffer"] = null;
  if (profile.grade === "E") {
    quote = { ...quote, decision: "decline", reasons: [...new Set([...quote.reasons, "HIGHEST_RISK_GRADE"])] };
  } else if (quote.decision !== "approve") {
    const { maxPrincipal } = await timed("max", maxApprovedPrincipal({ ...req, borrower: req.borrower }));
    if (Number(maxPrincipal) > 0 && Number(maxPrincipal) < Number(riskReq.principal)) {
      counterOffer = { requested: riskReq.principal, offered: fix6(maxPrincipal) };
      riskReq.principal = fix6(maxPrincipal);
      ({ quote, source: riskSource } = await timed("risk quote", risk.quote(riskReq)));
    }
  }
  // The memo is written in the background: the quote returns now and /borrow
  // shows APR, LTV and the lines immediately, then picks the memo up from
  // GET /loans/quote/:id/memo. Identical inputs reuse one Bedrock call.
  const memoReq = {
    creditProfile: { address, network: profile.network, score: profile.score, grade: profile.grade, confidence: profile.confidence, features: profile.features, reasons: profile.reasons },
    quote,
    // currency is explicit so the model never guesses XRP for the principal.
    loanRequest: { borrower: address, gpuId: gpu.id, collateralShares: riskReq.collateralShares, principal: riskReq.principal, currency: "USDC", termSeconds },
  };
  const memoPromise = memoFor(memoReq);
  const ready = memoReady.get(memoKey(memoReq)) ?? null;

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
    memo: ready,
    counterOffer,
    memoStatus: ready ? "ready" : "pending",
    revenue24h: fix6(buckets.reduce((s, b) => s + Number(b.revenue), 0)),
    sources: { credit: creditSource, risk: riskSource, memo: ready?.source ?? "pending", revenue: revenueSource, oracle: oracle.source === "live" ? "live" : "mock" },
  };
  db.prepare(`INSERT INTO loan_quotes (id, created_at, expires_at, body, used) VALUES (?, ?, ?, ?, 0)`).run(quoteId, new Date().toISOString(), expiresAt, JSON.stringify(out));
  memoByQuote.set(quoteId, memoPromise);
  void memoPromise.then((memo) => {
    const row = db.prepare(`SELECT body FROM loan_quotes WHERE id = ?`).get(quoteId) as { body: string } | undefined;
    if (!row) return;
    const body = JSON.parse(row.body) as LoanQuoteApiResponse;
    body.memo = memo;
    body.memoStatus = "ready";
    body.sources.memo = memo.source;
    db.prepare(`UPDATE loan_quotes SET body = ? WHERE id = ?`).run(JSON.stringify(body), quoteId);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Credit memo cache: one Bedrock call per distinct (profile, quote, request).
// Fallback results are not cached, so the next quote tries Bedrock again.
// ---------------------------------------------------------------------------

type MemoReq = Parameters<typeof pricing.creditMemo>[0];
const MEMO_TTL_MS = 60 * 60 * 1000;
const memoInflight = new Map<string, { at: number; p: Promise<AgentText> }>();
const memoReady = new Map<string, AgentText>();
const memoByQuote = new Map<string, Promise<AgentText>>();

function memoKey(req: MemoReq): string {
  const p = req.creditProfile as any;
  return createHash("sha256")
    .update(JSON.stringify([p.address, p.score, p.grade, p.confidence, req.quote, req.loanRequest]))
    .digest("hex");
}

function memoFor(req: MemoReq): Promise<AgentText> {
  const key = memoKey(req);
  const hit = memoInflight.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.p;
  const p = pricing.creditMemo(req).then((memo) => {
    if (memo.fellBack) memoInflight.delete(key);
    else memoReady.set(key, memo);
    return memo;
  });
  memoInflight.set(key, { at: Date.now(), p });
  return p;
}

// GET /loans/quote/:id/memo. With wait, holds the request until the memo is
// ready (or waitMs passes) so the page needs only one or two calls.
export async function quoteMemo(quoteId: string, waitMs = 0): Promise<{ status: "ready" | "pending"; memo: AgentText | null }> {
  const pending = memoByQuote.get(quoteId);
  if (pending) {
    const memo = waitMs > 0 ? await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]) : null;
    if (memo) return { status: "ready", memo };
  }
  const row = db.prepare(`SELECT body FROM loan_quotes WHERE id = ?`).get(quoteId) as { body: string } | undefined;
  if (!row) throw new LendingError("QUOTE_NOT_FOUND", "unknown quoteId", 404);
  const body = JSON.parse(row.body) as LoanQuoteApiResponse;
  return body.memo ? { status: "ready", memo: body.memo } : { status: "pending", memo: null };
}

// Largest principal risk approves for this collateral. Approval depends on
// the principal itself (dividend coverage falls as the loan grows), so this
// searches the risk model directly; no memo, no stored quote. The search is
// about 15 risk calls, so its result is kept per exact set of risk inputs
// (any change in profile, price, revenue or vault gives a new key).
const maxCache = swr<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("max", 30 * 60_000, 30 * 60_000);

export async function maxApprovedPrincipal(req: { borrower: string; gpuId: string; collateralShares: string; termSeconds?: number }) {
  const gpu = GPUS.find((g) => g.id === req.gpuId);
  if (!gpu) throw new LendingError("BAD_REQUEST", `unknown gpuId ${req.gpuId}`);
  const shares = Number(req.collateralShares);
  if (!(shares > 0)) throw new LendingError("BAD_REQUEST", "collateralShares must be positive");
  const name = lending.nameOf(req.borrower);
  const address = lending.addressOf(req.borrower);
  const [{ round, termSeconds }, { profile, oracle, buckets }] = await Promise.all([lendingTerm(req.termSeconds), riskInputs(gpu.id, address, name)]);
  // Grade E is the one grade that declines outright.
  if (profile.grade === "E") return { maxPrincipal: "0.00", collateralValue: fix6(shares * Number(oracle.price)), termSeconds };
  const base = {
    borrower: address,
    gpuId: gpu.id,
    collateralShares: fix6(shares),
    termSeconds,
    creditProfile: credit.toRiskProfile(profile),
    revenueHistory: buckets,
    collateralPrice: oracle.price,
    collateralPriceHistory: oracle.history,
  };
  const cap = Math.min(shares * Number(oracle.price), Number(round.assetsAvailable));
  const key = createHash("sha256").update(JSON.stringify([base, cap])).digest("hex");
  return maxCache.get(key, () => searchMax(base, shares, oracle.price, cap, termSeconds));
}

async function searchMax(base: Omit<Parameters<typeof risk.quote>[0], "principal">, shares: number, price: string, cap: number, termSeconds: number) {
  const approves = async (principal: number) => (await risk.quote({ ...base, principal: fix6(principal) })).quote.decision === "approve";
  let lo = 0;
  let hi = cap;
  if (!(await approves(1))) return { maxPrincipal: "0.00", collateralValue: fix6(shares * Number(price)), termSeconds };
  lo = 1;
  for (let i = 0; i < 14 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (await approves(mid)) lo = mid;
    else hi = mid;
  }
  // Whole USDC, a little under the edge so rounding never flips it to decline.
  return { maxPrincipal: Math.max(0, Math.floor(lo * 0.99)).toFixed(2), collateralValue: fix6(shares * Number(price)), termSeconds };
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

// actor(named) resolves who is acting (the signed-in account, or a trusted
// script's system account); a quote or loan can only be used by its owner.
type Actor = (named: string) => AccountName;

function mustOwn(actor: Actor | undefined, owner: string) {
  if (actor && actor(owner) !== owner) throw new LendingError("NOT_YOURS", "This loan belongs to another account.", 403);
}

export async function openFromQuote(quoteId: string, actor?: Actor): Promise<XlsLoanRecord> {
  const qrow = db.prepare(`SELECT * FROM loan_quotes WHERE id = ?`).get(quoteId) as any;
  if (!qrow) throw new LendingError("QUOTE_NOT_FOUND", "unknown quoteId; request a new quote", 404);
  if (qrow.used) throw new LendingError("QUOTE_USED", "this quote already opened a loan", 409);
  if (new Date(qrow.expires_at).getTime() < Date.now()) throw new LendingError("QUOTE_EXPIRED", "quote expired; request a new one", 409);
  const q = JSON.parse(qrow.body) as LoanQuoteApiResponse;
  if (q.quote.decision !== "approve") throw new LendingError("QUOTE_DECLINED", `risk declined this loan: ${q.quote.reasons.join(", ") || "LTV above max"}`, 409);
  const name = lending.nameOf(q.borrower);
  if (!name) throw new LendingError("BORROWER_NOT_CONFIGURED", "This account cannot sign loans.", 400);
  mustOwn(actor, name);

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

  credit.invalidateProfile(CREDIT_NETWORK(), q.borrowerAddress);
  const ledger = opened.loan;
  void credit.watch(CREDIT_NETWORK(), q.borrowerAddress, [
    { loanId: opened.loanId, dueAt: ledger?.nextPaymentDueDate ?? new Date(Date.now() + q.terms.paymentIntervalSeconds * 1000).toISOString(), principal: q.principal },
  ]);
  return (await loanRecord(opened.loanId))!;
}

export async function repay(id: string, mode: "full" | "next" = "full", actor?: Actor): Promise<XlsLoanRecord> {
  const r = getRow(id);
  if (!r) throw new LendingError("NOT_FOUND", "unknown loanId", 404);
  mustOwn(actor, r.borrower);
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
  credit.invalidateProfile(CREDIT_NETWORK(), r.borrowerAddress);
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
  credit.invalidateProfile(CREDIT_NETWORK(), r.borrowerAddress);
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
  credit.invalidateProfile(CREDIT_NETWORK(), r.borrowerAddress);
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
  oracleCache.invalidate(gpu.id);
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
  oracleCache.invalidate(gpuId);
  recordOracle(gpuId, price, "restore", tx.hash);
  preStressPrice.delete(gpuId);
  broadcast("risk", { type: "price_restore", gpuId, price, tx: tx.hash });
  return { price, tx };
}

export function asAccountName(s: string): AccountName {
  return (lending.nameOf(s) ?? s) as AccountName;
}

// ---------------------------------------------------------------------------
// Connected wallet (testnet): a Crossmark sign-in or a pasted address. It
// replaces the borrower's linked payment history in the credit profile; the
// credit service watches it live through Quicknode and reports changes.
// ---------------------------------------------------------------------------

async function walletCall<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await credit.creditRequest<T>(path, init);
  } catch (e) {
    if (!(e instanceof ServiceUnavailable)) throw e;
    const m = /HTTP (\d+) (.*)$/s.exec(e.message);
    if (!m) throw new LendingError("CREDIT_UNAVAILABLE", "The credit service is not reachable right now.", 503);
    let body: any = null;
    try {
      body = JSON.parse(m[2]);
    } catch {
      // not JSON
    }
    const err = body?.error ?? {};
    throw new LendingError(err.code ?? "CREDIT_ERROR", err.message ?? body?.detail ?? m[2], Number(m[1]));
  }
}

export function walletChallenge() {
  // No borrower yet: the account is looked up (or created) once the signature checks out.
  return walletCall<{ challengeId: string; message: string; messageHex: string; expiresAt: string }>("/link/challenge", {
    body: { borrower: "", network: "testnet" },
  });
}

export interface SignedIn {
  wallet: { address: string; network: string; verified: true; status: "verified"; connectedAt: string };
  account: { address: string; created: boolean; setupMs: number };
}

// Crossmark signed the challenge: verify it, then the wallet's Moonshift account
// (a ready one from the pool, or a new one), then link the wallet's history to
// that account in the credit service.
export async function walletSignIn(b: { challengeId: string; publicKey: string; signature: string; address?: string }): Promise<SignedIn> {
  const v = await walletCall<{ address: string; network: string; verifiedAt: string }>("/link/verify", { body: b });
  const { user, created, setupMs } = await accountForWallet(v.address, v.network);
  await walletCall("/link/wallet", { body: { borrower: user.address, address: v.address, network: v.network } });
  credit.invalidateProfile(CREDIT_NETWORK(), user.address);
  return {
    wallet: { address: v.address, network: v.network, verified: true, status: "verified", connectedAt: v.verifiedAt },
    account: { address: user.address, created, setupMs },
  };
}

// Operator reset (/admin/router): a fresh account for the wallet, linked to it
// in credit, so the score has no Moonshift loan history. Refused while the
// current account has a loan open.
export async function resetWalletAccount(wallet: string) {
  const prev = userForWallet(wallet);
  if (!prev) throw new LendingError("NO_ACCOUNT", "This wallet has no Moonshift account yet.", 404);
  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM xls_loans WHERE borrower_address = ? AND status IN ('open', 'margin_call')`)
    .get(prev.address) as { n: number };
  if (open.n > 0) throw new LendingError("LOAN_OPEN", "Repay the open loan before resetting this account.", 409);
  const r = await resetAccountForWallet(wallet);
  await walletCall("/link/wallet", { body: { borrower: r.user.address, address: wallet, network: r.user.walletNetwork } });
  credit.invalidateProfile(CREDIT_NETWORK(), r.previous);
  credit.invalidateProfile(CREDIT_NETWORK(), r.user.address);
  return { wallet, previousAccount: r.previous, account: r.user.address, setupMs: r.setupMs };
}

// The signed-in wallet, its account and the wallet's newest transactions.
export async function walletMe(user: UserAccount | null) {
  if (!user) return { wallet: null, account: null, activity: [] };
  const linked = await walletCall<{ wallet: Record<string, unknown> | null; activity?: unknown[] }>(`/link/wallet/${user.address}`).catch(() => null);
  return {
    wallet: { address: user.wallet, network: user.walletNetwork, verified: true, status: "verified", connectedAt: user.createdAt },
    account: { address: user.address },
    activity: linked?.activity ?? [],
  };
}

// The credit service rescored a borrower after live wallet activity.
export function creditProfileChanged(borrowerAddress: string): void {
  credit.invalidateProfile(CREDIT_NETWORK(), borrowerAddress);
}

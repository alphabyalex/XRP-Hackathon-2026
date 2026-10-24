// Adapter over services/risk (Kristian, port 7000). MOCK_RISK=1 (default)
// runs a TypeScript port of services/risk/app/risk.py calculate_quote, so
// mock and live quotes agree. MOCK_RISK=0 calls RISK_URL and falls back to
// the port (source "mock-fallback") if the service is unreachable. Stress
// and loan book outputs are always labeled simulated, as in the contracts.

import type {
  BookStats,
  DataSource,
  RiskQuote,
  RiskQuoteRequest,
  ScenarioRunRequest,
  ScenarioRunResponse,
} from "@moonshift/shared";
import { mockFlag } from "../env.js";
import { serviceJson, noteSource, ServiceUnavailable } from "./serviceFetch.js";

const RISK_URL = () => process.env.RISK_URL ?? "http://localhost:7000";
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_TERM_SECONDS = 600;
const PAYMENT_INTERVAL_SECONDS = Number(process.env.RISK_PAYMENT_INTERVAL_SECONDS ?? 60);

const GRADE_BASE_APR: Record<string, number> = { A: 0.05, B: 0.08, C: 0.12, D: 0.18, E: 0.3 };
const GRADE_MAX_LTV: Record<string, number> = { A: 0.65, B: 0.55, C: 0.45, D: 0.35, E: 0.2 };
const GRADE_PD: Record<string, number> = { A: 0.01, B: 0.03, C: 0.08, D: 0.2, E: 0.4 };

const r6 = (n: number) => (Number.isFinite(n) ? n : 0).toFixed(6);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

function meanAbsChange(history: { timestamp: string; price: string }[]): number {
  const pts = [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const ch: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const before = Number(pts[i - 1].price);
    if (before > 0) ch.push(Math.abs(Number(pts[i].price) - before) / before);
  }
  return ch.length ? ch.reduce((s, x) => s + x, 0) / ch.length : 0;
}

function projectedDividends(req: RiskQuoteRequest, termSeconds: number): number {
  let revenue = 0;
  let seconds = 0;
  for (const b of req.revenueHistory) {
    const s = (new Date(b.end).getTime() - new Date(b.start).getTime()) / 1000;
    if (s > 0) {
      revenue += Number(b.revenue);
      seconds += s;
    }
  }
  if (seconds === 0) return 0;
  const gross = (revenue / seconds) * termSeconds;
  return gross * 0.85 * 0.95 * (Number(req.collateralShares) / 1000);
}

// Port of calculate_quote() in services/risk/app/risk.py.
export function localQuote(req: RiskQuoteRequest): RiskQuote {
  const term = req.termSeconds || DEFAULT_TERM_SECONDS;
  const p = req.creditProfile;
  const grade = GRADE_BASE_APR[p.grade] !== undefined ? p.grade : "C";
  const principal = Number(req.principal);
  const collateralValue = Number(req.collateralShares) * Number(req.collateralPrice);
  const ltv = collateralValue > 0 ? principal / collateralValue : 99;
  const volatility = meanAbsChange(req.collateralPriceHistory);
  const volPenalty = Math.min(0.2, volatility * 2);
  const confFactor = 0.75 + 0.25 * p.confidence;
  const prelimMaxLtv = Math.max(0, GRADE_MAX_LTV[grade] * confFactor - volPenalty);
  const apr = GRADE_BASE_APR[grade] + ((100 - p.score) / 100) * 0.06;
  const paymentDue = principal * (1 + (apr * term) / YEAR_SECONDS);
  const dividends = projectedDividends(req, term);
  const coverage = paymentDue > 0 ? dividends / paymentDue : 0;
  const maxLtv = prelimMaxLtv * Math.min(1, coverage);
  const marginCallLtv = Math.min(0.85, maxLtv + 0.15);
  const liquidationLtv = Math.min(0.95, maxLtv + 0.3);
  const pd = clamp(
    GRADE_PD[grade] +
      ((100 - p.score) / 100) * 0.1 +
      (1 - p.confidence) * 0.05 +
      Math.max(0, 1 - coverage) * 0.15 +
      Math.max(0, ltv - maxLtv) * 0.2,
    0.001,
    0.99
  );
  const recovery = principal > 0 ? Math.min(1, (collateralValue * 0.9) / principal) : 1;
  const expectedLoss = principal * pd * (1 - recovery);
  const reasons: string[] = [];
  if (ltv > maxLtv) reasons.push("LTV_ABOVE_MAX");
  if (coverage < 1) reasons.push("LOW_DIVIDEND_COVERAGE");
  if (p.confidence < 0.5) reasons.push("THIN_CREDIT_FILE");
  if (volatility >= 0.05) reasons.push("HIGH_COLLATERAL_VOLATILITY");
  if (grade === "E") reasons.push("HIGHEST_RISK_GRADE");
  return {
    decision: ltv <= maxLtv ? "approve" : "decline",
    ltv: r6(ltv),
    maxLtv: r6(maxLtv),
    apr: r6(apr),
    marginCallLtv: r6(marginCallLtv),
    liquidationLtv: r6(liquidationLtv),
    termSeconds: term,
    paymentIntervalSeconds: Math.min(PAYMENT_INTERVAL_SECONDS, term),
    pd: r6(pd),
    pdLabel: "estimate",
    expectedLoss: r6(expectedLoss),
    coverageRatio: r6(coverage),
    reasons,
  };
}

export async function quote(req: RiskQuoteRequest): Promise<{ quote: RiskQuote; source: DataSource }> {
  if (mockFlag("MOCK_RISK")) {
    noteSource("risk", "mock");
    return { quote: localQuote(req), source: "mock" };
  }
  try {
    const q = await serviceJson<RiskQuote>("risk", `${RISK_URL()}/quote`, { body: req });
    noteSource("risk", "live");
    return { quote: q, source: "live" };
  } catch (e) {
    if (!(e instanceof ServiceUnavailable)) throw e;
    noteSource("risk", "mock-fallback");
    return { quote: localQuote(req), source: "mock-fallback" };
  }
}

// Simulated stress over the live book: ltv after a GPU price shock.
export function localScenario(
  req: ScenarioRunRequest,
  book: { loanId: string; outstanding: number; collateralValue: number; marginCallLtv: number; liquidationLtv: number }[],
  vault: { assetsTotal: number; cover: number; aprPct: number; utilization: number }
): ScenarioRunResponse {
  const mult = 1 + req.gpuPriceShockPct / 100;
  let mc = 0;
  let liq = 0;
  let loss = 0;
  const loans = book.map((l) => {
    const cv = l.collateralValue * mult;
    const ltv = cv > 0 ? l.outstanding / cv : 99;
    let state = "HEALTHY";
    if (ltv >= l.liquidationLtv) {
      state = "LIQUIDATE";
      liq++;
      loss += Math.max(0, l.outstanding - cv * 0.9);
    } else if (ltv >= l.marginCallLtv) {
      state = "MARGIN_CALL";
      mc++;
    }
    return { loanId: l.loanId, ltv: r6(ltv), state, simulated: true };
  });
  const absorbed = Math.min(loss, vault.cover);
  const apyBefore = (vault.aprPct / 100) * vault.utilization;
  const apyAfter = vault.assetsTotal > 0 ? Math.max(0, apyBefore - (loss - absorbed) / vault.assetsTotal) : apyBefore;
  return {
    loans,
    marginCalls: mc,
    liquidations: liq,
    vaultLoss: r6(loss),
    firstLossCoverAbsorbed: r6(absorbed),
    lenderApyBefore: r6(apyBefore),
    lenderApyAfter: r6(apyAfter),
    simulated: true,
  };
}

export async function runScenario(
  req: ScenarioRunRequest,
  fallback: () => ScenarioRunResponse
): Promise<{ result: ScenarioRunResponse; source: DataSource }> {
  if (mockFlag("MOCK_RISK")) return { result: fallback(), source: "mock" };
  try {
    return { result: await serviceJson<ScenarioRunResponse>("risk", `${RISK_URL()}/scenarios/run`, { body: req }), source: "live" };
  } catch {
    return { result: fallback(), source: "mock-fallback" };
  }
}

// Deterministic simulated loan book (matches contracts/risk/book_stats.json).
export function localBookStats(grade?: string): BookStats {
  const table: Record<string, [number, number, number]> = {
    A: [0.01, 0.05, 0.6],
    B: [0.03, 0.12, 0.5],
    C: [0.23, 0.3, 0.233333],
    D: [0.34, 0.42, 0.18],
    E: [0.52, 0.6, 0.1],
  };
  const grades = (grade ? [grade] : ["A", "B", "C", "D", "E"]).map((g) => {
    const [d, m, c] = table[g] ?? table.C;
    const loans = 100;
    const liquidated = Math.round(loans * d);
    const cured = Math.round(loans * m * c);
    return {
      grade: g,
      loans,
      defaultRate: r6(d),
      marginCallRate: r6(m),
      cureRate: r6(c),
      outcomes: { repaidOnTime: loans - liquidated - cured - 3, late: 3, marginCalledThenCured: cured, liquidated },
      simulated: true,
    };
  });
  return { periodDays: 30, borrowers: grades.length * 100, grades, simulated: true };
}

export async function bookStats(grade?: string): Promise<{ stats: BookStats; source: DataSource }> {
  if (mockFlag("MOCK_RISK")) return { stats: localBookStats(grade), source: "mock" };
  try {
    const q = grade ? `?grade=${encodeURIComponent(grade)}` : "";
    return { stats: await serviceJson<BookStats>("risk", `${RISK_URL()}/book/stats${q}`), source: "live" };
  } catch {
    return { stats: localBookStats(grade), source: "mock-fallback" };
  }
}

// True when the real risk keeper is expected to drive margin calls. When it
// is not (mock or unreachable), the api's built-in keeper does it.
export async function liveKeeperAvailable(): Promise<boolean> {
  if (mockFlag("MOCK_RISK")) return false;
  try {
    await serviceJson("risk", `${RISK_URL()}/health`, { timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

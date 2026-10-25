// Adapter over services/pricing (A9.3). MOCK_PRICING=1 (default) returns
// deterministic placeholder numbers. MOCK_PRICING=0 calls the real FastAPI
// service at PRICING_URL (owner Lucy).

import { HOSTING_FEE_BPS, RESERVE_BPS, LOAN, type GpuId } from "@moonshift/shared";
import { navInputs } from "../marketHistory.js";
import type { AgentText } from "@moonshift/shared";
import { serviceJson } from "./serviceFetch.js";
import type {
  InferenceRatesResponse,
  ContractPriceResponse,
  NavResponse,
  DividendsProposeRequest,
  DividendsProposeResponse,
  LoanQuoteRequest,
  LoanQuoteResponse,
  AgentExplainRequest,
  AgentExplainResponse,
} from "@moonshift/shared";

const MOCK = process.env.MOCK_PRICING !== "0";
// Not 6000: that port is on the fetch "bad ports" list (X11), so Node refuses it.
const PRICING_URL = process.env.PRICING_URL ?? "http://localhost:6100";
// Every pricing route checks this header when INTERNAL_API_KEY is set.
const AUTH = { "X-MS-Internal-Key": process.env.INTERNAL_API_KEY ?? "" };
const JSON_AUTH = { "Content-Type": "application/json", ...AUTH };

function inMinutes(n: number): string {
  return new Date(Date.now() + n * 60 * 1000).toISOString();
}

export async function getInferenceRates(gpuId: GpuId): Promise<InferenceRatesResponse> {
  if (!MOCK) {
    const res = await fetch(`${PRICING_URL}/rates/inference?gpu_id=${gpuId}`, { headers: AUTH });
    return (await res.json()) as InferenceRatesResponse;
  }
  return {
    input_per_mtok: "0.050000",
    output_per_mtok: "0.150000",
    base_fee: "0.000100",
    currency: "TDX",
    valid_until: inMinutes(1),
    inputs: { gpuId, note: "mock placeholder, pending real pricing model" },
  };
}

export async function getContractPrice(gpuId: GpuId, slotStart: string): Promise<ContractPriceResponse> {
  if (!MOCK) {
    const res = await fetch(`${PRICING_URL}/price/contract?gpu_id=${gpuId}&slot_start=${encodeURIComponent(slotStart)}`, { headers: AUTH });
    return (await res.json()) as ContractPriceResponse;
  }
  return {
    price_per_slot: "0.410000",
    slot_minutes: 5,
    reference_hourly_usd: "4.95",
    components: { hourly_usd: "4.95", margin_bps: 1500, fee_bps: 100 },
    valid_until: inMinutes(1),
    sources: ["mock placeholder, pending real pricing model"],
  };
}

export async function getNav(gpuId: GpuId): Promise<NavResponse> {
  if (!MOCK) {
    // Trailing revenue and dividends from the api's own records drive yield.
    const q = new URLSearchParams({ gpu_id: gpuId, ...(await navInputs(gpuId)) });
    const res = await fetch(`${PRICING_URL}/nav?${q}`, { headers: AUTH });
    return (await res.json()) as NavResponse;
  }
  return {
    nav_per_share: "1.045000",
    treasury_cash: "320.500000",
    pv_future_net: "724.500000",
    utilization_assumption: "35.00",
    trailing_revenue_24h: "48.200000",
    implied_yield_pct: "12.40",
    inputs: { gpuId, note: "mock placeholder" },
  };
}

export async function proposeDividends(req: DividendsProposeRequest): Promise<DividendsProposeResponse> {
  if (!MOCK) {
    const res = await fetch(`${PRICING_URL}/dividends/propose`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(req),
    });
    return (await res.json()) as DividendsProposeResponse;
  }
  const gross = Number(req.gross_revenue);
  const hostingFee = Math.round(gross * (HOSTING_FEE_BPS / 10000) * 1e6) / 1e6;
  const afterFee = gross - hostingFee;
  const reserve = Math.round(gross * (RESERVE_BPS / 10000) * 1e6) / 1e6; // 5% of gross, so holders get 80%
  const distributable = afterFee - reserve;
  const totalShares = req.holders.reduce((sum, h) => sum + Number(h.shares), 0);

  const payouts = req.holders.map((h) => ({
    account: h.account,
    amount: totalShares > 0 ? ((distributable * Number(h.shares)) / totalShares).toFixed(6) : "0.000000",
  }));
  const paidOut = payouts.reduce((s, p) => s + Number(p.amount), 0);
  const dust = (distributable - paidOut).toFixed(6);

  return {
    hosting_fee: hostingFee.toFixed(6),
    reserve: reserve.toFixed(6),
    distributable: distributable.toFixed(6),
    payouts,
    dust,
    explanation: `${req.gpu_id} earned ${gross.toFixed(2)} TDX this period. After a ${HOSTING_FEE_BPS / 100}% hosting fee and a ${RESERVE_BPS / 100}% reserve, ${distributable.toFixed(2)} TDX goes to shareholders. Mock explanation, pending the real Bedrock agent.`,
    risk_flags: [],
  };
}

export async function quoteLoan(req: LoanQuoteRequest): Promise<LoanQuoteResponse> {
  if (!MOCK) {
    const res = await fetch(`${PRICING_URL}/loans/quote`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(req),
    });
    return (await res.json()) as LoanQuoteResponse;
  }
  const sharePrice = 1.05; // mock, mirrors xrplAdapter's flat SHARE_PRICE
  const collateralValue = Number(req.shares) * sharePrice;
  const maxPrincipal = collateralValue * (LOAN.maxLtvBps / 10000);
  const liquidationValue = collateralValue * (LOAN.liquidationLtvBps / 10000);
  return {
    collateral_value: collateralValue.toFixed(6),
    max_principal: maxPrincipal.toFixed(6),
    apr_bps: LOAN.aprBps,
    liquidation_value: liquidationValue.toFixed(6),
    term_minutes: LOAN.demoTermMinutes,
  };
}

export async function explain(req: AgentExplainRequest): Promise<AgentExplainResponse> {
  if (!MOCK) {
    const res = await fetch(`${PRICING_URL}/agent/explain`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify(req),
    });
    return (await res.json()) as AgentExplainResponse;
  }
  return {
    text: `Mock explanation for ${req.context}: ${JSON.stringify(req.data)}. Deterministic fallback, pending the real Bedrock agent.`,
    risk_flags: [],
  };
}

// ---------------------------------------------------------------------------
// Bedrock agent (Tharun): plain-English credit memo and risk alerts. Bedrock
// explains numbers, it never creates them. Mock and fallback text is built
// from the same numbers and flagged fellBack: true.
// ---------------------------------------------------------------------------

function pct(x: string | number, digits = 1): string {
  return `${(Number(x) * 100).toFixed(digits)}%`;
}

export function fallbackCreditMemo(req: { creditProfile: any; quote: any; loanRequest: any }): string {
  const p = req.creditProfile;
  const q = req.quote;
  const l = req.loanRequest;
  const days = Math.round(Number(l.termSeconds) / 86400);
  const term = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.round(Number(l.termSeconds) / 60)} minutes`;
  const decision = q.decision === "approve" ? "Approved" : "Declined";
  return (
    `${decision}. The borrower holds grade ${p.grade} credit (score ${p.score}, ${p.confidence} confidence). ` +
    `The request is ${Number(l.principal).toFixed(2)} USDC against ${Number(l.collateralShares).toFixed(0)} shares of ${String(l.gpuId).toUpperCase()}, ` +
    `an LTV of ${pct(q.ltv)} against a maximum of ${pct(q.maxLtv)}. ` +
    `Projected dividends cover ${Number(q.coverageRatio).toFixed(2)}x the amount due over ${term}. ` +
    `APR ${pct(q.apr, 2)}, estimated default probability ${pct(q.pd)}. ` +
    `A margin call fires at ${pct(q.marginCallLtv)} LTV and liquidation at ${pct(q.liquidationLtv)}.`
  );
}

export async function creditMemo(req: { creditProfile: any; quote: any; loanRequest: any }): Promise<AgentText> {
  const fallback = (source: AgentText["source"]): AgentText => ({ text: fallbackCreditMemo(req), modelId: null, latencyMs: 0, fellBack: true, source });
  if (MOCK) return fallback("mock");
  try {
    const res = await serviceJson<{ memo: string; modelId?: string; latencyMs?: number; fellBack?: boolean; outcome?: string }>(
      "pricing",
      `${PRICING_URL}/agent/credit-memo`,
      // Longer than pricing's own 12 s Bedrock budget, so pricing always answers first.
      { body: req, timeoutMs: 15000 }
    );
    if (res.fellBack) console.warn(`credit memo fell back: ${res.outcome ?? "unknown"} after ${res.latencyMs ?? 0} ms`);
    return { text: res.memo, modelId: res.modelId ?? null, latencyMs: res.latencyMs ?? 0, fellBack: Boolean(res.fellBack), source: "live", outcome: res.outcome };
  } catch (e) {
    console.warn(`credit memo: pricing unreachable (${(e as Error).message})`);
    return fallback("mock-fallback");
  }
}

export async function riskAlert(req: {
  type: "margin_call" | "liquidation";
  loanId: string;
  borrower: string;
  gpuId: string;
  ltv: string;
  thresholdLtv: string;
  liquidationLtv: string;
  outstandingBalance: string;
  collateralValue: string;
  reason: string;
}): Promise<AgentText> {
  const text =
    req.type === "margin_call"
      ? `Margin call on your loan. LTV rose to ${pct(req.ltv)}, above the ${pct(req.thresholdLtv)} margin call line. Add collateral or pay down principal on the ${Number(req.outstandingBalance).toFixed(2)} USDC balance to avoid liquidation at ${pct(req.liquidationLtv)}.`
      : `Your loan was liquidated at ${pct(req.ltv)} LTV, above the ${pct(req.liquidationLtv)} liquidation line. Your locked GPU shares (worth ${Number(req.collateralValue).toFixed(2)} USDC) repaid the lender; first-loss cover absorbs part of any shortfall.`;
  const fallback = (source: AgentText["source"]): AgentText => ({ text, modelId: null, latencyMs: 0, fellBack: true, source });
  if (MOCK) return fallback("mock");
  try {
    const res = await serviceJson<{ alert: string; modelId?: string; latencyMs?: number; fellBack?: boolean }>(
      "pricing",
      `${PRICING_URL}/agent/risk-alert`,
      { body: req, timeoutMs: 12000 }
    );
    return { text: res.alert, modelId: res.modelId ?? null, latencyMs: res.latencyMs ?? 0, fellBack: Boolean(res.fellBack), source: "live" };
  } catch {
    return fallback("mock-fallback");
  }
}

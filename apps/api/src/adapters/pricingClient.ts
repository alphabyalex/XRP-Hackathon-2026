// Pricing calls use the pricing service. Unavailable numeric data stays unavailable.
// Only prose can fall back, deterministically, from the supplied real numbers.
import type {
  GpuId, AgentText, InferenceRatesResponse, ContractPriceResponse, NavResponse,
  DividendsProposeRequest, DividendsProposeResponse, LoanQuoteRequest,
  LoanQuoteResponse, AgentExplainRequest, AgentExplainResponse,
} from "@moonshift/shared";
import { navInputs } from "../marketHistory.js";
import { serviceJson } from "./serviceFetch.js";

const PRICING_URL = process.env.PRICING_URL ?? "http://localhost:6100";

export async function getInferenceRates(gpuId: GpuId): Promise<InferenceRatesResponse> {
  return serviceJson("pricing", `${PRICING_URL}/rates/inference?gpu_id=${encodeURIComponent(gpuId)}`);
}
export async function getContractPrice(gpuId: GpuId, slotStart: string): Promise<ContractPriceResponse> {
  const q = new URLSearchParams({ gpu_id: gpuId, slot_start: slotStart });
  return serviceJson("pricing", `${PRICING_URL}/price/contract?${q}`);
}
export async function getNav(gpuId: GpuId): Promise<NavResponse> {
  const q = new URLSearchParams({ gpu_id: gpuId, ...(await navInputs(gpuId)) });
  return serviceJson("pricing", `${PRICING_URL}/nav?${q}`);
}
export async function proposeDividends(req: DividendsProposeRequest): Promise<DividendsProposeResponse> {
  return serviceJson("pricing", `${PRICING_URL}/dividends/propose`, { body: req, timeoutMs: 15000 });
}
export async function quoteLoan(req: LoanQuoteRequest): Promise<LoanQuoteResponse> {
  return serviceJson("pricing", `${PRICING_URL}/loans/quote`, { body: req });
}
export async function explain(req: AgentExplainRequest): Promise<AgentExplainResponse> {
  return serviceJson("pricing", `${PRICING_URL}/agent/explain`, { body: req, timeoutMs: 15000 });
}

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

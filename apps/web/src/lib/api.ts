// Client for apps/api. No env var read here (apps/web can't see the
// monorepo-root .env without extra Next config, and we're not allowed to
// touch .env), so the base URL is the same localhost:4000 default apps/api
// itself binds to (packages/shared PORTS.api).

import { PORTS } from "@moonshift/shared";
import type {
  ApiGpuSummary,
  ApiGpuDetail,
  PortfolioResponse,
  TxLogEntry,
  TxResult,
  RedeemContractsResponse,
  ChatCompletionResponse,
  LoanRecord,
} from "@moonshift/shared";

export const API_BASE = `http://localhost:${PORTS.api}`;

export class ApiUnreachableError extends Error {
  constructor() {
    super("Can't reach the Moonshift API on port 4000. Start it with npm run dev.");
    this.name = "ApiUnreachableError";
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiUnreachableError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `apps/api returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const getGpus = () => apiFetch<ApiGpuSummary[]>("/gpus");
export const getGpu = (id: string) => apiFetch<ApiGpuDetail>(`/gpus/${id}`);
export const getPortfolio = (account: string) => apiFetch<PortfolioResponse>(`/portfolio/${account}`);
export const getTxLog = () => apiFetch<TxLogEntry[]>("/tx");

export const buyShares = (buyer: string, gpuId: string, qty: string) =>
  apiFetch<TxResult>("/shares/buy", { method: "POST", body: JSON.stringify({ buyer, gpuId, qty }) });

export const bookSlots = (buyer: string, gpuId: string, qty: string) =>
  apiFetch<TxResult>("/contracts/buy", { method: "POST", body: JSON.stringify({ buyer, gpuId, qty }) });

export const redeemSlots = (holder: string, gpuId: string, qty: string, slotStart: string) =>
  apiFetch<RedeemContractsResponse>("/contracts/redeem", {
    method: "POST",
    body: JSON.stringify({ holder, gpuId, qty, slotStart }),
  });

export const openLoan = (borrower: string, gpuId: string, collateralShares: string) =>
  apiFetch<LoanRecord>("/loans/open", {
    method: "POST",
    body: JSON.stringify({ borrower, gpuId, collateralShares }),
  });

export const repayLoan = (loanId: string) =>
  apiFetch<LoanRecord>(`/loans/${loanId}/repay`, { method: "POST", body: "{}" });

export const chat = (messages: { role: "user"; content: string }[], buyer = "DEV") =>
  apiFetch<ChatCompletionResponse>("/inference/chat", {
    method: "POST",
    body: JSON.stringify({ buyer, messages }),
  });

export const getMonteCarloStatus = () => apiFetch<Record<string, any>>("/monte-carlo/status");

export const triggerSwitchDemo = (gpuId: string = "gpu-a", prompt?: string) =>
  apiFetch<any>(`/monte-carlo/switch-demo?gpu_id=${gpuId}`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });

export function eventsUrl(): string {
  return `${API_BASE}/events`;
}

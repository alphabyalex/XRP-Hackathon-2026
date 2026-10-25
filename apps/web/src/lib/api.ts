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

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.API_URL ||
  (typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? `${window.location.origin}/api`
    : `http://localhost:${PORTS.api}`)
).replace(/\/+$/, "");

// The api answered 401: nobody is signed in (the wallet session cookie is missing).
export class NotConnectedError extends Error {
  constructor(message = "Connect your wallet to see your account") {
    super(message);
    this.name = "NotConnectedError";
  }
}

export class ApiUnreachableError extends Error {
  constructor() {
    super("Can't reach the Moonshift API on port 4000. Start it with npm run dev.");
    this.name = "ApiUnreachableError";
  }
}

// NEXT_PUBLIC_DEBUG_TIMING=1 logs start, end and duration of every api call.
const DEBUG_TIMING = process.env.NEXT_PUBLIC_DEBUG_TIMING === "1";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DEBUG_TIMING) return apiFetchRaw<T>(path, init);
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const name = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
  console.log(`[timing] ${name} start ${Math.round(t0)} ms`);
  try {
    return await apiFetchRaw<T>(path, init);
  } finally {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    console.log(`[timing] ${name} end ${Math.round(t1)} ms (${Math.round(t1 - t0)} ms)`);
  }
}

async function apiFetchRaw<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
      // The wallet session is an httpOnly cookie on the api's origin.
      credentials: "include",
    });
  } catch {
    throw new ApiUnreachableError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body?.error?.code === "NOT_CONNECTED") throw new NotConnectedError(body.error.message);
    throw new Error(body?.error?.message ?? `apps/api returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const getGpus = () => apiFetch<ApiGpuSummary[]>("/gpus");
export const getGpu = (id: string) => apiFetch<ApiGpuDetail>(`/gpus/${id}`);
// The signed-in account (the api resolves "me" from the session).
export const getPortfolio = (init?: RequestInit) => apiFetch<PortfolioResponse>("/portfolio/me", init);
export const getTxLog = () => apiFetch<TxLogEntry[]>("/tx");

export const buyShares = (gpuId: string, qty: string) =>
  apiFetch<TxResult>("/shares/buy", { method: "POST", body: JSON.stringify({ gpuId, qty }) });

export const bookSlots = (gpuId: string, qty: string) =>
  apiFetch<TxResult>("/contracts/buy", { method: "POST", body: JSON.stringify({ gpuId, qty }) });

export const redeemSlots = (gpuId: string, qty: string, slotStart: string) =>
  apiFetch<RedeemContractsResponse>("/contracts/redeem", {
    method: "POST",
    body: JSON.stringify({ gpuId, qty, slotStart }),
  });

export const openLoan = (gpuId: string, collateralShares: string) =>
  apiFetch<LoanRecord>("/loans/open", {
    method: "POST",
    body: JSON.stringify({ gpuId, collateralShares }),
  });

export const repayLoan = (loanId: string) =>
  apiFetch<LoanRecord>(`/loans/${loanId}/repay`, { method: "POST", body: "{}" });

export const chat = (messages: { role: "user"; content: string }[]) =>
  apiFetch<ChatCompletionResponse>("/inference/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
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

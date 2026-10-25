// Client for apps/api. No env var read here (apps/web can't see the
// monorepo-root .env without extra Next config, and we're not allowed to
// touch .env), so the base URL is the same localhost:4000 default apps/api
// itself binds to (packages/shared PORTS.api).

import { PORTS } from "@moonshift/shared";
import { isPublicRead, publicReadCache } from "./publicReadCache";
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

// In a browser off localhost, always call the same origin's /api (next.config.mjs proxies it), so the
// SameSite=Lax wallet session cookie is sent. The server and localhost talk to the api directly.
const browserOffLocalhost = typeof window !== "undefined" && window.location.hostname !== "localhost";
export const API_BASE = (
  browserOffLocalhost
    ? `${window.location.origin}/api`
    : process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || `http://localhost:${PORTS.api}`
).replace(/\/+$/, "");

// The api answered 401: nobody is signed in (the wallet session cookie is missing).
export class NotConnectedError extends Error {
  constructor(message = "Connect your wallet to see your account") {
    super(message);
    this.name = "NotConnectedError";
  }
}

// The api answered 404 (for a GPU: not in the registry, or not online yet).
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
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
const publicReads = publicReadCache();
export function invalidatePublicReads() { publicReads.invalidate(); }

function readOrFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const write = (init?.method ?? "GET").toUpperCase() !== "GET";
  if (write) {
    invalidatePublicReads();
    return apiFetchRaw<T>(path, init).finally(invalidatePublicReads);
  }
  if (typeof window !== "undefined" && isPublicRead(path, init)) return publicReads.get(path, () => apiFetchRaw<T>(path, init));
  return apiFetchRaw<T>(path, init);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DEBUG_TIMING) return readOrFetch<T>(path, init);
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const name = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
  console.log(`[timing] ${name} start ${Math.round(t0)} ms`);
  try {
    return await readOrFetch<T>(path, init);
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
    if (res.status === 404) throw new NotFoundError(body?.error?.message);
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

// Compute catalog writes (contracts/compute). Shapes live in ./catalog.
import type { Booking, Sizing, TaskEstimate, TaskQuote } from "./catalog";
export const estimateTask = (description: string, type: string) =>
  apiFetch<TaskEstimate>("/tasks/estimate", { method: "POST", body: JSON.stringify({ description, type }) });
export const quoteTask = (q: Omit<Sizing, "model"> & { gpuId: string; mode: string }) =>
  apiFetch<TaskQuote>("/tasks/quote", { method: "POST", body: JSON.stringify(q) });
export const bookHour = (gpuId: string, slotStart: string, priceCap: string) =>
  apiFetch<Booking>("/bookings", { method: "POST", body: JSON.stringify({ gpuId, slotStart, durationSeconds: 3600, priceCap }) });

import type { BookingRange, BookingQuote, BookingChallenge, SignedBooking } from "./bookingWallet";
export const quoteBookingRange = (range: BookingRange) =>
  apiFetch<BookingQuote>("/bookings/quote", { method: "POST", body: JSON.stringify(range) });
export const requestBookingConsent = (range: BookingRange & { priceCap: string }) =>
  apiFetch<BookingChallenge>("/bookings/challenge", { method: "POST", body: JSON.stringify(range) });
export const bookRange = (signed: SignedBooking) =>
  apiFetch<Booking>("/bookings", { method: "POST", headers: { "Idempotency-Key": signed.challengeId }, body: JSON.stringify(signed) });

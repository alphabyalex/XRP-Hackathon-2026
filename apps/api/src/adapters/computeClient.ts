// Compute results and telemetry come only from the compute service. An unavailable
// provider must never become a successful booking, generated reply, or made-up history.
import { SLOT_MINUTES, type GpuId, type RevenueBucket } from "@moonshift/shared";
import type {
  ChatCompletionRequest, ChatCompletionResponse, ComputeGpuStatus, CalendarEntry,
  BookingRequest, BookingResponse, ComputeErrorCode,
} from "@moonshift/shared";
import { internalHeaders } from "./serviceFetch.js";

export class ComputeError extends Error {
  constructor(public code: ComputeErrorCode, message: string, public status = 409) {
    super(message);
  }
}

async function computeJson<T>(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<T> {
  const base = (process.env.COMPUTE_URL ?? "http://127.0.0.1:5001").replace(/\/+$/, "").replace("://localhost:", "://127.0.0.1:");
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...internalHeaders(Boolean(init.body)), ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
      const code = body?.error?.code;
      const known = new Set(["GPU_BOOKED", "NO_CAPACITY", "BOOKING_NOT_FOUND", "UPSTREAM_ERROR", "BAD_REQUEST", "SLOT_TAKEN"]);
      throw new ComputeError(code && known.has(code) ? code as ComputeErrorCode : "UPSTREAM_ERROR",
        response.status === 409 ? "The requested GPU time is already reserved." : "Compute is unavailable. Please try again.",
        response.status >= 500 ? 503 : response.status);
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ComputeError) throw error;
    throw new ComputeError("UPSTREAM_ERROR", "Compute is unavailable. Please try again.", 503);
  }
}

export function resetMockCompute(): void { /* retained for older callers; no in-memory provider */ }

export function slotEndFor(slotStart: string, slots: number): string {
  return new Date(new Date(slotStart).getTime() + slots * SLOT_MINUTES * 60_000).toISOString();
}

export async function getGpus(): Promise<ComputeGpuStatus[]> {
  const rows = await computeJson<ComputeGpuStatus[]>("/gpus");
  return rows.filter((row) => !row.simulated && row.state !== "OFFLINE");
}

export function getCalendar(gpuId: GpuId, from: string, to: string): Promise<CalendarEntry[]> {
  const query = new URLSearchParams({ from, to });
  return computeJson(`/gpus/${encodeURIComponent(gpuId)}/calendar?${query}`);
}

export function createBooking(request: BookingRequest): Promise<BookingResponse> {
  return computeJson("/bookings", { method: "POST", body: JSON.stringify(request) });
}

export async function cancelBooking(bookingId: string): Promise<boolean> {
  try {
    await computeJson(`/bookings/${encodeURIComponent(bookingId)}`, { method: "DELETE" });
    return true;
  } catch { return false; }
}

export function chatCompletions(body: ChatCompletionRequest, buyer: string, bookingId?: string): Promise<ChatCompletionResponse> {
  return computeJson("/v1/chat/completions", {
    method: "POST",
    headers: { "X-MS-Buyer": buyer, ...(bookingId ? { "X-MS-Booking": bookingId } : {}) },
    body: JSON.stringify(body),
  }, 35_000);
}

export async function getRevenueHistory(gpuId: GpuId, hours = 24, _legacyRevenue24h?: number): Promise<{ buckets: RevenueBucket[]; source: "live" }> {
  const to = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const from = new Date(to.getTime() - hours * 3_600_000);
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const raw = await computeJson<any>(`/gpus/${encodeURIComponent(gpuId)}/revenue?${query}`);
  const list: any[] = Array.isArray(raw) ? raw : raw.buckets ?? raw.history ?? [];
  const buckets = list.filter((row) => !row.simulated && row.revenueAvailable !== false && (row.revenue ?? row.revenueTdx ?? row.gross) != null).map((row): RevenueBucket => {
    const booked = Number(row.bookedMinutes ?? row.booked_minutes ?? 0);
    const inference = Number(row.inferenceMinutes ?? row.inference_minutes ?? 0);
    const start = row.start ?? row.bucketStart;
    const end = row.end ?? row.bucketEnd;
    const span = (new Date(end).getTime() - new Date(start).getTime()) / 60_000;
    return {
      start, end,
      revenue: Number(row.revenue ?? row.revenueTdx ?? row.gross ?? 0).toFixed(6),
      bookedMinutes: booked, inferenceMinutes: inference,
      idleMinutes: Number(row.idleMinutes ?? row.idle_minutes ?? Math.max(0, span - booked - inference)),
      utilizationPct: Number(row.utilizationPct ?? (span > 0 ? (booked + inference) / span * 100 : 0)).toFixed(6),
      simulated: false,
    };
  });
  return { buckets, source: "live" };
}

export function getMonteCarloStatus(): Promise<any> {
  return computeJson("/monte-carlo/status");
}

export function runSwitchDemo(gpuId = "gpu-a", prompt?: string): Promise<any> {
  const query = new URLSearchParams({ gpu_id: gpuId, ...(prompt ? { prompt } : {}) });
  return computeJson(`/monte-carlo/switch-demo?${query}`, { method: "POST" }, 35_000);
}

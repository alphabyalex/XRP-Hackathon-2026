// Adapter over services/compute (A9.2). MOCK_COMPUTE=1 (default) simulates
// GPU state, booking, and chat completions in memory. MOCK_COMPUTE=0 calls
// the real FastAPI service at COMPUTE_URL (owner Kristian).

import { randomBytes } from "crypto";
import { GPUS, SLOT_MINUTES, type GpuId } from "@moonshift/shared";
import type { RevenueBucket } from "@moonshift/shared";
import { serviceJson } from "./serviceFetch.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ComputeGpuStatus,
  CalendarEntry,
  BookingRequest,
  BookingResponse,
  ComputeErrorCode,
} from "@moonshift/shared";

const MOCK = process.env.MOCK_COMPUTE !== "0";
const COMPUTE_URL = process.env.COMPUTE_URL ?? "http://localhost:5000";

export class ComputeError extends Error {
  code: ComputeErrorCode;
  status: number;
  constructor(code: ComputeErrorCode, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface MockBooking {
  gpu_id: GpuId;
  slot_start: string;
  slot_end: string;
  holder: string;
  redemption_id: string;
  booking_id: string;
}

const bookings: MockBooking[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function activeBookingFor(gpuId: GpuId, at: Date): MockBooking | undefined {
  return bookings.find(
    (b) => b.gpu_id === gpuId && new Date(b.slot_start) <= at && at < new Date(b.slot_end)
  );
}

export function resetMockCompute(): void {
  bookings.length = 0;
}

export function slotEndFor(slotStart: string, slots: number): string {
  return new Date(new Date(slotStart).getTime() + slots * SLOT_MINUTES * 60 * 1000).toISOString();
}

export async function getGpus(): Promise<ComputeGpuStatus[]> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/gpus`);
    return (await res.json()) as ComputeGpuStatus[];
  }
  const now = new Date();
  return GPUS.map((g) => {
    const booked = activeBookingFor(g.id, now);
    return {
      id: g.id,
      state: booked ? "BOOKED" : "READY",
      model: g.model,
      simulated: false,
      tokens_per_sec: g.id === "gpu-a" ? 42.5 : 40,
      utilization_pct_1h: g.id === "gpu-a" ? 18.2 : 9,
      monte_carlo: {
        status: booked ? "PREEMPTED" : "RUNNING",
        workload_type: booked ? "LLM_INFERENCE" : "MONTE_CARLO_RISK_SIMULATION",
        resident_model: g.id === "gpu-b" ? "Qwen/Qwen2.5-32B-Instruct" : g.model,
        risk_simulation: {
          paths_simulated: g.id === "gpu-b" ? 4850000 : 2650000,
          throughput_paths_per_sec: g.id === "gpu-b" ? 599998.9 : 299999.4,
          value_at_risk_99: 0.0342,
        },
        instant_preemption: {
          last_switch_latency_ms: g.id === "gpu-b" ? 2.7 : 3.38,
          total_switches: 4,
          zero_cold_start: true,
        },
      },
    };
  });
}

export async function getCalendar(gpuId: GpuId, from: string, to: string): Promise<CalendarEntry[]> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/gpus/${gpuId}/calendar?from=${from}&to=${to}`);
    return (await res.json()) as CalendarEntry[];
  }
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const booked = bookings
    .filter((b) => b.gpu_id === gpuId)
    .map((b) => ({ start: b.slot_start, end: b.slot_end, kind: "BOOKED" as const, ref: b.redemption_id }));
  return [...mockHistory(gpuId, fromMs, Math.min(toMs, Date.now())), ...booked].filter(
    (e) => new Date(e.end).getTime() > fromMs && new Date(e.start).getTime() < toMs
  );
}

// Simulated past schedule so mock mode looks like a working GPU instead of a
// day of idle time. Deterministic per GPU and 30 minute block, so it does not
// jump around between refreshes. Rough targets: GPU-A about 18% utilized,
// GPU-B about 9%, matching getGpus() above. Only used when MOCK_COMPUTE=1.
function blockHash(gpuId: string, block: number): number {
  let h = 2166136261;
  const s = gpuId + ":" + block;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Final mix so neighbouring blocks get unrelated values.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mockHistory(gpuId: GpuId, fromMs: number, toMs: number): CalendarEntry[] {
  const SLOT_MS = 5 * 60 * 1000;
  const BLOCK_MS = 6 * SLOT_MS;
  const [pBooked, pInference] = gpuId === "gpu-a" ? [0.09, 0.18] : [0.04, 0.1];
  const out: CalendarEntry[] = [];
  for (let block = Math.floor(fromMs / BLOCK_MS); block * BLOCK_MS < toMs; block++) {
    const r = blockHash(gpuId, block);
    if (r >= pBooked + pInference) continue;
    const kind = r < pBooked ? ("BOOKED" as const) : ("INFERENCE" as const);
    const len = 2 + Math.floor(blockHash(gpuId, block + 0.5) * 5); // 2 to 6 slots
    const start = block * BLOCK_MS;
    const end = Math.min(start + len * SLOT_MS, toMs);
    if (end <= start) continue;
    out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), kind, ref: "calendar" });
  }
  return out;
}

export async function createBooking(req: BookingRequest): Promise<BookingResponse> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MS-Internal-Key": process.env.INTERNAL_API_KEY ?? "" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new ComputeError("UPSTREAM_ERROR", "booking failed upstream", res.status);
    return (await res.json()) as BookingResponse;
  }
  const slotStart = new Date(req.slot_start);
  const slotEnd = new Date(slotStart.getTime() + req.slots * SLOT_MINUTES * 60 * 1000);
  const conflict = bookings.find(
    (b) =>
      b.gpu_id === req.gpu_id &&
      slotStart < new Date(b.slot_end) &&
      slotEnd > new Date(b.slot_start)
  );
  if (conflict) {
    throw new ComputeError("UPSTREAM_ERROR", "SLOT_TAKEN", 409);
  }
  const booking_id = "booking_" + randomBytes(8).toString("hex");
  bookings.push({
    gpu_id: req.gpu_id,
    slot_start: req.slot_start,
    slot_end: slotEnd.toISOString(),
    holder: req.holder,
    redemption_id: req.redemption_id,
    booking_id,
  });
  return { booking_id };
}

export async function chatCompletions(
  body: ChatCompletionRequest,
  buyer: string,
  bookingId?: string
): Promise<ChatCompletionResponse> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MS-Buyer": buyer,
        ...(bookingId ? { "X-MS-Booking": bookingId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: { code?: ComputeErrorCode; message?: string } };
      throw new ComputeError(err.error?.code ?? "UPSTREAM_ERROR", err.error?.message ?? "compute error", res.status);
    }
    return (await res.json()) as ChatCompletionResponse;
  }

  const now = new Date();
  let gpuId: GpuId = "gpu-a";
  const booked = activeBookingFor(gpuId, now);
  let routed_reason = "lowest utilization READY gpu";

  if (booked && booked.redemption_id !== bookingId) {
    // gpu-a is booked by someone else right now, try gpu-b
    gpuId = "gpu-b";
    const bookedB = activeBookingFor(gpuId, now);
    if (bookedB && bookedB.redemption_id !== bookingId) {
      throw new ComputeError("GPU_BOOKED", `gpu-a is booked until ${booked.slot_end}`, 409);
    }
    routed_reason = "gpu-a booked, routed to gpu-b";
  }

  const lastMessage = body.messages[body.messages.length - 1]?.content ?? "";
  const input_tokens = Math.max(1, Math.ceil(lastMessage.length / 4));
  const output_tokens = 24;
  const simulated = gpuId === "gpu-b";
  const usingBooking = Boolean(bookingId && booked?.redemption_id === bookingId);
  // Mock rate, the real service would ask services/pricing. Flat placeholder here.
  const charge = usingBooking ? "0" : (input_tokens * 0.00002 + output_tokens * 0.00006).toFixed(6);

  const gpu = GPUS.find((g) => g.id === gpuId)!;
  return {
    id: "chatcmpl-" + randomBytes(8).toString("hex"),
    object: "chat.completion",
    created: Math.floor(now.getTime() / 1000),
    model: gpu.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `[mock inference on ${gpu.label}] You said: ${lastMessage.slice(0, 200)}`,
        },
        finish_reason: "stop",
      },
    ],
    x_ms: {
      request_id: "req_" + randomBytes(8).toString("hex"),
      gpu_id: gpuId,
      model: gpu.model,
      input_tokens,
      output_tokens,
      charge,
      routed_reason,
      simulated,
    },
  };
}

// ---------------------------------------------------------------------------
// Revenue history (risk underwriting input). Shape is what services/risk
// expects: start, end, revenue, bookedMinutes, inferenceMinutes, idleMinutes,
// utilizationPct, simulated. Mock buckets come from the same calendar the
// schedule draws, so the schedule and the revenue agree.
// ---------------------------------------------------------------------------

export async function getRevenueHistory(
  gpuId: GpuId,
  hours = 24,
  revenue24h = 48.2
): Promise<{ buckets: RevenueBucket[]; source: "live" | "mock" | "mock-fallback" }> {
  const to = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const from = new Date(to.getTime() - hours * 3600000);
  if (!MOCK) {
    try {
      const raw = await serviceJson<any>("compute", `${COMPUTE_URL}/gpus/${gpuId}/revenue?from=${from.toISOString()}&to=${to.toISOString()}`, { timeoutMs: 5000 });
      const list: any[] = Array.isArray(raw) ? raw : raw.buckets ?? raw.history ?? [];
      const buckets = list.map((b) => {
        const booked = Number(b.bookedMinutes ?? b.booked_minutes ?? 0);
        const inference = Number(b.inferenceMinutes ?? b.inference_minutes ?? 0);
        const span = (new Date(b.end ?? b.bucketEnd).getTime() - new Date(b.start ?? b.bucketStart).getTime()) / 60000 || 60;
        return {
          start: b.start ?? b.bucketStart,
          end: b.end ?? b.bucketEnd,
          revenue: Number(b.revenue ?? b.revenueTdx ?? b.gross ?? 0).toFixed(6),
          bookedMinutes: booked,
          inferenceMinutes: inference,
          idleMinutes: Number(b.idleMinutes ?? b.idle_minutes ?? Math.max(0, span - booked - inference)),
          utilizationPct: Number(b.utilizationPct ?? ((booked + inference) / span) * 100).toFixed(6),
          simulated: Boolean(b.simulated),
        };
      });
      if (buckets.length) return { buckets, source: "live" };
    } catch {
      // fall through to the simulated history
    }
  }
  const cal = await getCalendar(gpuId, from.toISOString(), to.toISOString());
  const minutesIn = (startMs: number, endMs: number, kind: string) =>
    cal
      .filter((e) => e.kind === kind)
      .reduce((s, e) => {
        const a = Math.max(startMs, new Date(e.start).getTime());
        const b = Math.min(endMs, new Date(e.end).getTime());
        return s + Math.max(0, b - a) / 60000;
      }, 0);
  const rows = Array.from({ length: hours }, (_, i) => {
    const s = from.getTime() + i * 3600000;
    const e = s + 3600000;
    const booked = Math.round(minutesIn(s, e, "BOOKED"));
    const inference = Math.round(minutesIn(s, e, "INFERENCE"));
    return { s, e, booked, inference };
  });
  const util = rows.reduce((a, r) => a + r.booked + r.inference, 0) || 1;
  const buckets: RevenueBucket[] = rows.map((r) => ({
    start: new Date(r.s).toISOString(),
    end: new Date(r.e).toISOString(),
    revenue: ((revenue24h * (hours / 24) * (r.booked + r.inference)) / util).toFixed(6),
    bookedMinutes: r.booked,
    inferenceMinutes: r.inference,
    idleMinutes: Math.max(0, 60 - r.booked - r.inference),
    utilizationPct: (((r.booked + r.inference) / 60) * 100).toFixed(6),
    simulated: true,
  }));
  return { buckets, source: MOCK ? "mock" : "mock-fallback" };
}

export async function getMonteCarloStatus(): Promise<any> {
  try {
    const res = await fetch(`${COMPUTE_URL}/monte-carlo/status`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fall back to local mock telemetry
  }
  return {
    "gpu-a": {
      status: "RUNNING",
      workload_type: "MONTE_CARLO_RISK_SIMULATION",
      resident_model: "Qwen/Qwen3-1.7B",
      risk_simulation: { paths_simulated: 3200000, throughput_paths_per_sec: 299999.4, value_at_risk_99: 0.0315 },
      instant_preemption: { last_switch_latency_ms: 3.38, total_switches: 2, zero_cold_start: true },
    },
    "gpu-b": {
      status: "RUNNING",
      workload_type: "MONTE_CARLO_RISK_SIMULATION",
      resident_model: "Qwen/Qwen2.5-32B-Instruct",
      risk_simulation: { paths_simulated: 5100000, throughput_paths_per_sec: 599998.9, value_at_risk_99: 0.0342 },
      instant_preemption: { last_switch_latency_ms: 2.7, total_switches: 2, zero_cold_start: true },
    },
  };
}

export async function runSwitchDemo(gpuId: string = "gpu-a", prompt?: string): Promise<any> {
  try {
    const q = prompt ? `?gpu_id=${gpuId}&prompt=${encodeURIComponent(prompt)}` : `?gpu_id=${gpuId}`;
    const res = await fetch(`${COMPUTE_URL}/monte-carlo/switch-demo${q}`, { method: "POST" });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fall back to simulated switch transition
  }
  return {
    demo: "INSTANT_GPU_WORKLOAD_SWITCH",
    gpu_id: gpuId,
    resident_model: gpuId === "gpu-b" ? "Qwen/Qwen2.5-32B-Instruct" : "Qwen/Qwen3-1.7B",
    switch_transition: {
      initial_workload: "MONTE_CARLO_RISK_SIMULATION",
      preemption_latency_ms: gpuId === "gpu-b" ? 2.7 : 3.38,
      switched_to: "LLM_INFERENCE",
      inference_completion: "Simulated instant inference completed for " + (prompt || "Monte Carlo switch test"),
      tokens_generated: 32,
      inference_latency_ms: 48.5,
      restoration_latency_ms: 0.02,
      final_workload: "MONTE_CARLO_RISK_SIMULATION",
      total_preempt_and_resume_overhead_ms: gpuId === "gpu-b" ? 2.72 : 3.4,
      idle_waste_seconds: 0.0,
    },
    monte_carlo_telemetry: {
      paths_before_switch: 3200000,
      paths_after_resume: 3200000,
      paths_per_second: gpuId === "gpu-b" ? 600000 : 300000,
      value_at_risk_99: 0.032,
    },
  };
}

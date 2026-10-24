// Adapter over services/compute (A9.2). MOCK_COMPUTE=1 (default) simulates
// GPU state, booking, and chat completions in memory. MOCK_COMPUTE=0 calls
// the real FastAPI service at COMPUTE_URL (owner Kristian).

import { randomBytes } from "crypto";
import { GPUS, SLOT_MINUTES, type GpuId } from "@moonshift/shared";
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
      simulated: g.id === "gpu-b", // GPU B is simulated until a second real box exists
      tokens_per_sec: g.id === "gpu-a" ? 42.5 : 40,
      utilization_pct_1h: g.id === "gpu-a" ? 18.2 : 9,
    };
  });
}

export async function getCalendar(gpuId: GpuId, from: string, to: string): Promise<CalendarEntry[]> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/gpus/${gpuId}/calendar?from=${from}&to=${to}`);
    return (await res.json()) as CalendarEntry[];
  }
  return bookings
    .filter((b) => b.gpu_id === gpuId)
    .map((b) => ({ start: b.slot_start, end: b.slot_end, kind: "BOOKED" as const, ref: b.redemption_id }));
}

export async function createBooking(req: BookingRequest): Promise<BookingResponse> {
  if (!MOCK) {
    const res = await fetch(`${COMPUTE_URL}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        "X-GB-Buyer": buyer,
        ...(bookingId ? { "X-GB-Booking": bookingId } : {}),
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
    x_gb: {
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

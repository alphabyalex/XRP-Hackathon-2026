// Pure validation and arithmetic shared by the task routes and focused tests.
export const SERVING_MODEL = "Qwen/Qwen2.5-1.5B-Instruct";
export const MODES = ["cheapest", "balanced", "fastest"] as const;
export type TaskMode = typeof MODES[number];
export type TaskType = "inference" | "fine-tune" | "render" | "other";
export interface Sizing { gpus: number; vcpu: number; ramGb: number; storageGb: number; durationSeconds: number; model: string | null }
export interface QuoteInput extends Omit<Sizing, "model"> { gpuId?: string; mode: TaskMode }
export interface RentalOffer {
  id: string; vcpu: number | null; ramGb: number | null; storageGb: number | null;
  prices: { rentalUsdPerHour: string | null; economy: { updatedAt: string } | null };
  nodes: { total: number; free: number | null };
}
export class TaskError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export function integer(value: unknown, field: string, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw new TaskError("BAD_REQUEST", `${field} must be an integer from ${low} through ${high}.`);
  }
  return value;
}
export function parseEstimate(body: unknown): { description: string; type: TaskType } {
  const data = body as Record<string, unknown> | undefined;
  const description = typeof data?.description === "string" ? data.description.trim() : "";
  if (!description || description.length > 10000) throw new TaskError("BAD_REQUEST", "description must contain 1 through 10000 characters.");
  const type = data?.type ?? "inference";
  if (typeof type !== "string" || !["inference", "fine-tune", "render", "other"].includes(type)) throw new TaskError("BAD_REQUEST", "type must be inference, fine-tune, render or other.");
  return { description, type: type as TaskType };
}
export function fallbackSizing(description: string, type: TaskType): Sizing {
  if (type === "inference") return { gpus: 1, vcpu: 2, ramGb: 4, storageGb: 10, durationSeconds: Math.min(120, Math.max(1, Math.ceil(description.length / 2000))) * 60, model: SERVING_MODEL };
  if (type === "fine-tune") return { gpus: 1, vcpu: 4, ramGb: 16, storageGb: 50, durationSeconds: 3600, model: null };
  if (type === "render") return { gpus: 1, vcpu: 4, ramGb: 8, storageGb: 20, durationSeconds: 1800, model: null };
  return { gpus: 1, vcpu: 2, ramGb: 4, storageGb: 10, durationSeconds: 600, model: null };
}
export function parseSizing(value: unknown, type: TaskType): Sizing {
  const data = value as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") throw new TaskError("BAD_REQUEST", "Sizing is missing.");
  const expected = type === "inference" ? SERVING_MODEL : null;
  if (data.model !== expected) throw new TaskError("BAD_REQUEST", "The suggested model is not supported.");
  return {
    gpus: integer(data.gpus, "gpus", 1, 8), vcpu: integer(data.vcpu, "vcpu", 1, 128),
    ramGb: integer(data.ramGb, "ramGb", 1, 1024), storageGb: integer(data.storageGb, "storageGb", 1, 10000),
    durationSeconds: integer(data.durationSeconds, "durationSeconds", 60, 604800), model: expected,
  };
}
export function parseQuote(body: unknown): QuoteInput {
  const data = body as Record<string, unknown> | undefined;
  const mode = data?.mode ?? "balanced";
  if (!MODES.includes(mode as TaskMode)) throw new TaskError("BAD_REQUEST", "mode must be cheapest, balanced or fastest.");
  if (data?.gpuId !== undefined && (typeof data.gpuId !== "string" || !/^gpu-[a-z0-9-]{1,40}$/.test(data.gpuId))) throw new TaskError("BAD_REQUEST", "gpuId is invalid.");
  return {
    gpuId: data?.gpuId as string | undefined, mode: mode as TaskMode,
    gpus: integer(data?.gpus, "gpus", 1, 8), vcpu: integer(data?.vcpu, "vcpu", 1, 128),
    ramGb: integer(data?.ramGb, "ramGb", 1, 1024), storageGb: integer(data?.storageGb, "storageGb", 1, 10000),
    durationSeconds: integer(data?.durationSeconds, "durationSeconds", 60, 604800),
  };
}
export function fits(input: Pick<QuoteInput, "gpus" | "vcpu" | "ramGb" | "storageGb">, gpu: RentalOffer): boolean {
  return input.gpus <= gpu.nodes.total && gpu.vcpu !== null && gpu.ramGb !== null && gpu.storageGb !== null
    && input.vcpu <= gpu.vcpu * input.gpus && input.ramGb <= gpu.ramGb * input.gpus && input.storageGb <= gpu.storageGb * input.gpus;
}
export function buildQuote(input: QuoteInput, offers: RentalOffer[], now = Date.now()) {
  const matching = offers.filter(gpu => (!input.gpuId || gpu.id === input.gpuId) && fits(input, gpu));
  if (!matching.length) throw new TaskError("NO_COMPATIBLE_GPU", "No healthy GPU supports these resources.", 409);
  const priced = matching.filter(gpu => {
    const rate = Number(gpu.prices.rentalUsdPerHour);
    const time = Date.parse(gpu.prices.economy?.updatedAt ?? "");
    return Number.isFinite(rate) && rate > 0 && Number.isFinite(time) && now - time < 48 * 3600000 && time <= now + 300000;
  });
  if (!priced.length) throw new TaskError("PRICING_UNAVAILABLE", "Live rental prices are not available yet.", 503);
  const price = (gpu: RentalOffer) => Number(gpu.prices.rentalUsdPerHour) * input.gpus;
  const byCost = (a: RentalOffer, b: RentalOffer) => price(a) - price(b) || a.id.localeCompare(b.id);
  const byAvailability = (a: RentalOffer, b: RentalOffer) => Number((b.nodes.free ?? 0) >= input.gpus) - Number((a.nodes.free ?? 0) >= input.gpus) || byCost(a, b);
  const options = MODES.map(mode => {
    const gpu = [...priced].sort(mode === "cheapest" ? byCost : byAvailability)[0];
    const hourly = price(gpu);
    // Round the authorized cap upward to the ledger currency's six decimals.
    const total = (Math.ceil((hourly * input.durationSeconds / 3600 - Number.EPSILON) * 1e6) / 1e6).toFixed(6);
    return { mode, gpuId: gpu.id, gpus: input.gpus, pricePerHour: hourly.toFixed(6), totalPrice: total,
      priceCap: total, estimatedDurationSeconds: input.durationSeconds,
      availableNow: (gpu.nodes.free ?? 0) >= input.gpus, updatedAt: gpu.prices.economy!.updatedAt };
  });
  const selected = options.find(option => option.mode === input.mode)!;
  return { currency: "USD", ...selected, options,
    formula: "Live GPU Economy hourly median multiplied by GPU count and duration. CPU, RAM and storage are included within the node limits.",
    durationSource: "request_estimate", performanceNote: "No measured speed difference is available. All modes retain the requested duration." };
}

export interface CalendarEvent { start: string; end: string; kind: string; ref: string }
export async function settleHeldBooking<T extends { hash: string; validated: boolean; result: string }>(operations: {
  charge: () => Promise<T>; release: () => Promise<void>; pending: (hash: string | null) => void;
}): Promise<T> {
  let payment: T;
  try { payment = await operations.charge(); } catch {
    try { operations.pending(null); } catch { /* The pre-submit pending row remains the authority. */ }
    throw new TaskError("PAYMENT_PENDING", "Payment confirmation is pending. The reservation is held for reconciliation. Do not pay again.", 503);
  }
  if (!payment.validated) {
    try { operations.pending(payment.hash); } catch { /* Never turn an uncertain payment into a generic retryable error. */ }
    throw new TaskError("PAYMENT_PENDING", "Payment confirmation is pending. Do not pay again.", 503);
  }
  if (payment.result !== "tesSUCCESS") {
    try { await operations.release(); } catch {
      throw new TaskError("CANCELLATION_PENDING", "The payment failed. Releasing the reservation is awaiting reconciliation. Do not submit another payment.", 503);
    }
    throw new TaskError("PAYMENT_FAILED", "The payment did not complete. No rental charge was settled.", 402);
  }
  return payment;
}
export function hourlyBlocks(events: CalendarEvent[], from: number, to: number) {
  const overlapMinutes = (segments: Array<[number, number]>, start: number, end: number) => {
    const clipped = segments.map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as [number, number]).filter(([a, b]) => a < b).sort((a, b) => a[0] - b[0]);
    let total = 0, lastEnd = start;
    for (const [a, b] of clipped) { total += Math.max(0, b - Math.max(a, lastEnd)); lastEnd = Math.max(lastEnd, b); }
    return Math.round(total / 60000 * 1000) / 1000;
  };
  const blocks = [];
  for (let start = from; start < to; start += 3600000) {
    const end = Math.min(to, start + 3600000);
    const inBlock = events.filter(event => Date.parse(event.start) < end && Date.parse(event.end) > start);
    const segments = (kind: string) => inBlock.filter(event => event.kind === kind || (kind === "BOOKED" && event.kind === "HOLD")).map(event => [Date.parse(event.start), Date.parse(event.end)] as [number, number]);
    const bookedMinutes = overlapMinutes(segments("BOOKED"), start, end);
    const runningMinutes = overlapMinutes(segments("INFERENCE"), start, end);
    blocks.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), bookedMinutes, runningMinutes,
      status: bookedMinutes ? "booked" : runningMinutes ? "running" : "free", refs: [...new Set(inBlock.map(event => event.ref))] });
  }
  return blocks;
}

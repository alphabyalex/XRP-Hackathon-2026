import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { SLOT_MINUTES, type GpuId } from "@moonshift/shared";
import * as ledger from "@moonshift/xrpl";
import { internalHeaders, serviceJson } from "../adapters/serviceFetch.js";
import { db as defaultDb } from "../db/db.js";
import { addRevenue as defaultAddRevenue, logTx as defaultLogTx } from "../db/helpers.js";
import { actorFor as defaultActorFor } from "../middleware/session.js";
import { broadcast as defaultBroadcast } from "../sse.js";
import { cachedRentalCatalog as defaultCachedCatalog, getRentalCatalog as defaultGetCatalog } from "../marketData/rentalCatalog.js";
import { buildQuote, fallbackSizing, fits, hourlyBlocks, integer, parseEstimate, parseQuote, parseSizing, settleHeldBooking, TaskError, type CalendarEvent, type Sizing } from "./tasksCore.js";

const computeUrl = () => (process.env.COMPUTE_URL ?? "http://localhost:5001").replace(/\/+$/, "");
const pricingUrl = () => (process.env.PRICING_URL ?? "http://localhost:6100").replace(/\/+$/, "");

interface EstimateResult { source: string; modelId: string | null; sizing: unknown }
export interface TaskRouteDependencies {
  db: typeof defaultDb;
  cachedCatalog: typeof defaultCachedCatalog;
  getCatalog: typeof defaultGetCatalog;
  actor: typeof defaultActorFor;
  pay: typeof ledger.payForInference;
  addRevenue: typeof defaultAddRevenue;
  logTx: typeof defaultLogTx;
  broadcast: typeof defaultBroadcast;
  fetchUpstream: typeof fetch;
  liveEnabled: () => boolean;
  estimate: (input: ReturnType<typeof parseEstimate>) => Promise<EstimateResult>;
}

// Production defaults remain real services. Tests replace only these boundaries.
export function createTasksRouter(overrides: Partial<TaskRouteDependencies> = {}) {
const tasksRouter = Router();
const db = overrides.db ?? defaultDb;
const cachedRentalCatalog = overrides.cachedCatalog ?? defaultCachedCatalog;
const getRentalCatalog = overrides.getCatalog ?? defaultGetCatalog;
const actorFor = overrides.actor ?? defaultActorFor;
const pay = overrides.pay ?? ledger.payForInference;
const addRevenue = overrides.addRevenue ?? defaultAddRevenue;
const logTx = overrides.logTx ?? defaultLogTx;
const broadcast = overrides.broadcast ?? defaultBroadcast;
const fetchUpstream = overrides.fetchUpstream ?? fetch;
const liveEnabled = overrides.liveEnabled ?? (() => process.env.MOCK_XRPL === "0" && process.env.MOCK_COMPUTE === "0");
const estimate = overrides.estimate ?? ((input: ReturnType<typeof parseEstimate>) => serviceJson<EstimateResult>("pricing", `${pricingUrl()}/agent/task-estimate`, { body: input, timeoutMs: 13000 }));

// Keep an audit record before any remote reservation or ledger mutation. An uncertain
// payment remains pending, preserving its reservation for operator reconciliation.
db.exec(`CREATE TABLE IF NOT EXISTS task_bookings (
  id TEXT PRIMARY KEY, holder TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  gpu_id TEXT NOT NULL, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL,
  amount TEXT NOT NULL, status TEXT NOT NULL, booking_id TEXT,
  payment_hash TEXT, response TEXT, updated_at TEXT NOT NULL,
  UNIQUE(holder, idempotency_key)
)`);

type BookingRow = { id: string; status: string; response: string | null };
function fail(res: Response, error: unknown): void {
  if (error instanceof TaskError) res.status(error.status).json({ error: { code: error.code, message: error.message } });
  else res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "This service is temporarily unavailable." } });
}
function quoteFromCache(body: unknown) {
  const input = parseQuote(body);
  const catalog = cachedRentalCatalog();
  if (!catalog) {
    void getRentalCatalog().catch(() => {});
    throw new TaskError("PRICING_UNAVAILABLE", "Live rental prices are not available yet.", 503);
  }
  return buildQuote(input, catalog.gpus);
}

tasksRouter.post("/tasks/quote", (req, res) => {
  try { res.json(quoteFromCache(req.body)); } catch (error) { fail(res, error); }
});

tasksRouter.post("/tasks/estimate", async (req, res) => {
  const started = Date.now();
  try {
    const input = parseEstimate(req.body);
    let sizing: Sizing = fallbackSizing(input.description, input.type);
    let source: "bedrock" | "fallback" = "fallback";
    let modelId: string | null = null;
    try {
      const result = await estimate(input);
      const validated = parseSizing(result.sizing, input.type);
      if (result.source === "bedrock" || result.source === "fallback") {
        sizing = validated;
        source = result.source;
        modelId = source === "bedrock" && typeof result.modelId === "string" ? result.modelId : null;
      }
    } catch { /* The API also has the same deterministic estimator if pricing is offline. */ }
    const catalog = cachedRentalCatalog();
    if (!catalog) void getRentalCatalog().catch(() => {});
    // Current healthy endpoints run text inference only. Do not suggest undeployed
    // training or rendering capabilities just because their hardware could fit.
    const suggestedGpus = input.type === "inference" ? (catalog?.gpus ?? []).filter(gpu => fits(sizing, gpu)).map(gpu => gpu.id) : [];
    let pricing = null;
    if (suggestedGpus.length) {
      try { pricing = buildQuote({ ...sizing, mode: "balanced" }, (catalog?.gpus ?? []).filter(gpu => suggestedGpus.includes(gpu.id))); } catch { /* No live rate means no price. */ }
    }
    res.json({ source, modelId, region: "us-east-2", latencyMs: Date.now() - started,
      sizing, suggestedGpus, pricing, availability: suggestedGpus.length ? "available" : input.type === "inference" ? "offline" : "unsupported" });
  } catch (error) { fail(res, error); }
});

async function computeJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: globalThis.Response;
  try {
    response = await fetchUpstream(`${computeUrl()}${path}`, {
      method: init.method ?? "GET", headers: internalHeaders(init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(5000),
    });
  } catch { throw new TaskError("COMPUTE_UNAVAILABLE", "The compute service is not reachable.", 503); }
  if (!response.ok) {
    if (response.status === 409) throw new TaskError("SLOT_TAKEN", "The requested GPU slot is already booked or running work would overlap it.", 409);
    if (response.status === 404) throw new TaskError("NOT_FOUND", "This GPU is not available.", 404);
    throw new TaskError("COMPUTE_UNAVAILABLE", "The compute service could not process this request.", 503);
  }
  return await response.json() as T;
}
async function requireRealGpu(gpuId: string): Promise<void> {
  const catalog = cachedRentalCatalog() ?? await getRentalCatalog();
  if (!catalog.gpus.some(gpu => gpu.id === gpuId)) throw new TaskError("NOT_FOUND", "This GPU is not online.", 404);
  const [health, gpus] = await Promise.all([
    computeJson<{ mock?: boolean }>("/health"),
    computeJson<Array<{ id: string; simulated?: boolean; state: string }>>("/gpus"),
  ]);
  const gpu = gpus.find(item => item.id === gpuId);
  if (health.mock !== false || !gpu || gpu.simulated !== false || gpu.state === "OFFLINE") throw new TaskError("COMPUTE_UNAVAILABLE", "This GPU is not available for live work.", 503);
}

tasksRouter.get("/gpus/:id/calendar", async (req, res) => {
  try {
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    integer(days, "days", 1, 7);
    const gpuId = req.params.id;
    await requireRealGpu(gpuId);
    const from = Math.floor(Date.now() / 3600000) * 3600000;
    const to = from + days * 86400000;
    const events = await computeJson<CalendarEvent[]>(`/gpus/${encodeURIComponent(gpuId)}/calendar?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`);
    if (!Array.isArray(events) || events.some(event => !["BOOKED", "INFERENCE", "HOLD"].includes(event.kind) || !Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.end)) || Date.parse(event.end) <= Date.parse(event.start))) throw new TaskError("COMPUTE_UNAVAILABLE", "The live calendar could not be read.", 503);
    res.json({ gpuId, from: new Date(from).toISOString(), to: new Date(to).toISOString(), updatedAt: new Date().toISOString(), events, blocks: hourlyBlocks(events, from, to) });
  } catch (error) { fail(res, error); }
});

const bookingLocks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = bookingLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  bookingLocks.set(key, next);
  try { return await next; } finally { if (bookingLocks.get(key) === next) bookingLocks.delete(key); }
}
function updateBooking(id: string, status: string, bookingId: string | null = null, paymentHash: string | null = null, response: unknown = null): void {
  db.prepare("UPDATE task_bookings SET status=?,booking_id=COALESCE(?,booking_id),payment_hash=COALESCE(?,payment_hash),response=?,updated_at=? WHERE id=?")
    .run(status, bookingId, paymentHash, response === null ? null : JSON.stringify(response), new Date().toISOString(), id);
}
async function releaseHold(id: string, bookingId: string): Promise<void> {
  try {
    await computeJson(`/bookings/${encodeURIComponent(bookingId)}`, { method: "DELETE" });
    updateBooking(id, "cancelled", bookingId);
  } catch {
    try { updateBooking(id, "cancellation_pending", bookingId); } catch { /* Keep the durable pre-submit pending row. */ }
    throw new TaskError("CANCELLATION_PENDING", "The payment failed. Releasing the reservation is awaiting reconciliation. Do not submit another payment.", 503);
  }
}

tasksRouter.post("/bookings", async (req: Request, res: Response) => {
  try {
    let holder: ReturnType<typeof actorFor>;
    try { holder = actorFor(req); } catch { throw new TaskError("NOT_CONNECTED", "Connect your wallet to reserve a GPU.", 401); }
    if (!liveEnabled()) throw new TaskError("BOOKING_UNAVAILABLE", "Live reservations are not enabled.", 503);
    const data = req.body as Record<string, unknown> | undefined;
    const gpuId = typeof data?.gpuId === "string" ? data.gpuId : "";
    if (!/^gpu-[a-z0-9-]{1,40}$/.test(gpuId)) throw new TaskError("BAD_REQUEST", "gpuId is invalid.");
    const slotStart = typeof data?.slotStart === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.slotStart) ? Date.parse(data.slotStart) : NaN;
    if (!Number.isFinite(slotStart) || slotStart <= Date.now() || slotStart > Date.now() + 7 * 86400000) throw new TaskError("BAD_REQUEST", "slotStart must be a future time within seven days.");
    const slotSeconds = SLOT_MINUTES * 60;
    if (!Number.isSafeInteger(slotSeconds) || slotSeconds <= 0) throw new TaskError("BOOKING_UNAVAILABLE", "The booking interval is not configured.", 503);
    const durationSeconds = integer(data?.durationSeconds, "durationSeconds", slotSeconds, 288 * slotSeconds);
    if (durationSeconds % slotSeconds) throw new TaskError("BAD_REQUEST", `durationSeconds must be a multiple of ${slotSeconds}.`);
    const cap = typeof data?.priceCap === "string" || typeof data?.priceCap === "number" ? Number(data.priceCap) : NaN;
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1000) throw new TaskError("BAD_REQUEST", "priceCap must be greater than zero and no more than 1000.");
    const idempotencyKey = req.header("Idempotency-Key") ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new TaskError("BAD_REQUEST", "Idempotency-Key is invalid.");
    await serialized(gpuId, async () => {
      const existing = db.prepare("SELECT id,status,response FROM task_bookings WHERE holder=? AND idempotency_key=?").get(holder, idempotencyKey) as BookingRow | undefined;
      if (existing) {
        if (existing.status === "confirmed" && existing.response) { res.json(JSON.parse(existing.response)); return; }
        throw new TaskError("BOOKING_PENDING", "This reservation already exists or is awaiting reconciliation. Do not submit another payment.", 409);
      }
      await requireRealGpu(gpuId);
      const catalog = cachedRentalCatalog()!;
      const gpu = catalog.gpus.find(item => item.id === gpuId)!;
      // Reserve the whole physical node. Sliders do not create fractional GPU capacity.
      if (gpu.vcpu === null || gpu.ramGb === null || gpu.storageGb === null) throw new TaskError("BOOKING_UNAVAILABLE", "Hardware limits are not available.", 503);
      const quote = buildQuote({ gpuId, gpus: 1, vcpu: gpu.vcpu, ramGb: gpu.ramGb, storageGb: gpu.storageGb, durationSeconds, mode: "balanced" }, [gpu]);
      if (Number(quote.totalPrice) > cap) throw new TaskError("PRICE_CAP_EXCEEDED", "The current rental price exceeds your price cap.", 409);
      const redemptionId = `reservation_${randomUUID()}`;
      const start = new Date(slotStart).toISOString();
      const end = new Date(slotStart + durationSeconds * 1000).toISOString();
      db.prepare("INSERT INTO task_bookings (id,holder,idempotency_key,gpu_id,slot_start,slot_end,amount,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(redemptionId, holder, idempotencyKey, gpuId, start, end, quote.totalPrice, "reserving", new Date().toISOString());
      let bookingId: string;
      try {
        const booking = await computeJson<{ booking_id: string }>("/bookings", { method: "POST", body: { gpu_id: gpuId, slot_start: start, slots: durationSeconds / slotSeconds, redemption_id: redemptionId, holder } });
        if (!booking.booking_id) throw new TaskError("COMPUTE_UNAVAILABLE", "The reservation could not be confirmed.", 503);
        bookingId = booking.booking_id;
      } catch (error) { updateBooking(redemptionId, error instanceof TaskError && error.status === 409 ? "cancelled" : "reservation_pending"); throw error; }
      updateBooking(redemptionId, "payment_pending", bookingId);
      const payment = await settleHeldBooking({
        charge: () => pay({ payer: holder, gpuId: gpuId as GpuId, amount: quote.totalPrice, memo: `MS_BOOKING ${redemptionId} ${start} ${end}` }),
        release: () => releaseHold(redemptionId, bookingId),
        pending: hash => updateBooking(redemptionId, "payment_pending", bookingId, hash),
      });
      const result = { bookingId, redemptionId, gpuId, slotStart: start, slotEnd: end,
        amount: quote.totalPrice, currency: "TDX", priceSource: "GPU Economy", priceUpdatedAt: quote.updatedAt, payment };
      try {
        db.exec("BEGIN");
        db.prepare("INSERT INTO bookings (id,gpu_id,slot_start,slot_end,holder,redemption_id) VALUES (?,?,?,?,?,?)").run(bookingId, gpuId, start, end, holder, redemptionId);
        addRevenue(gpuId, "contract", quote.totalPrice, payment.hash);
        logTx(payment, "bookGpu", holder, `${holder} reserved ${gpuId} from ${start} to ${end}`);
        updateBooking(redemptionId, "confirmed", bookingId, payment.hash, result);
        db.exec("COMMIT");
      } catch {
        try { db.exec("ROLLBACK"); } catch { /* BEGIN itself may have failed. */ }
        try { updateBooking(redemptionId, "payment_pending", bookingId, payment.hash); } catch { /* Preserve the explicit paid-but-pending response even if the database is unavailable. */ }
        throw new TaskError("BOOKING_PENDING", "Your payment was confirmed. Reservation records are awaiting reconciliation. Do not pay again.", 503);
      }
      broadcast("calendar", { gpu_id: gpuId, start, end, kind: "BOOKED", ref: redemptionId });
      broadcast("tx", { hash: payment.hash, kind: "bookGpu", account: holder });
      res.status(201).json(result);
    });
  } catch (error) { fail(res, error); }
});

return tasksRouter;
}

export const tasksRouter = createTasksRouter();

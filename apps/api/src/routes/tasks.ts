import { Router, type Request, type Response, type RequestHandler } from "express";
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
import { BookingConsents, type BookingIdentity, type BookingTerms } from "./bookingConsent.js";
import { requirePromptFunding } from "../middleware/funding.js";

const computeUrl = () => (process.env.COMPUTE_URL ?? "http://127.0.0.1:5001").replace(/\/+$/, "").replace("://localhost:", "://127.0.0.1:");
const pricingUrl = () => (process.env.PRICING_URL ?? "http://localhost:6100").replace(/\/+$/, "");

interface EstimateResult { source: string; taskType?: string; modelId: string | null; sizing: unknown }
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
  bookingIdentity: (req: Request) => BookingIdentity;
  consentClock: () => number;
  funding: RequestHandler;
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
const consentClock = overrides.consentClock ?? Date.now;
const bookingIdentity = overrides.bookingIdentity ?? ((req: Request): BookingIdentity => {
  let holder: ReturnType<typeof actorFor>;
  try { holder = actorFor(req); } catch { throw new TaskError("NOT_CONNECTED", "Connect your wallet to reserve a GPU.", 401); }
  const user = req.user;
  if (!user || user.name !== holder || !user.wallet || !user.address) throw new TaskError("NOT_CONNECTED", "Connect your wallet to reserve a GPU.", 401);
  return { holder, wallet: user.wallet, account: user.address };
});
const consents = new BookingConsents(db, consentClock);
const funding = overrides.funding ?? requirePromptFunding;
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

tasksRouter.post("/tasks/estimate", funding, async (req, res) => {
  const started = Date.now();
  try {
    const input = parseEstimate(req.body);
    let sizing: Sizing = fallbackSizing(input.description, input.type);
    let source: "bedrock" | "fallback" = "fallback";
    let modelId: string | null = null;
    // Bedrock classifies the task from its description; otherwise the requested type stands.
    let taskType: typeof input.type = input.type;
    try {
      const result = await estimate(input);
      const kind = (["inference", "fine-tune", "render", "other"] as const).find((k) => k === result.taskType) ?? input.type;
      const validated = parseSizing(result.sizing, kind);
      if (result.source === "bedrock" || result.source === "fallback") {
        sizing = validated;
        source = result.source;
        taskType = kind;
        modelId = source === "bedrock" && typeof result.modelId === "string" ? result.modelId : null;
      }
    } catch { /* The API also has the same deterministic estimator if pricing is offline. */ }
    const catalog = cachedRentalCatalog();
    if (!catalog) void getRentalCatalog().catch(() => {});
    // Current healthy endpoints run text inference only. Do not suggest undeployed
    // training or rendering capabilities just because their hardware could fit.
    const suggestedGpus = taskType === "inference" ? (catalog?.gpus ?? []).filter(gpu => fits(sizing, gpu)).map(gpu => gpu.id) : [];
    let pricing = null;
    if (suggestedGpus.length) {
      try { pricing = buildQuote({ ...sizing, mode: "balanced" }, (catalog?.gpus ?? []).filter(gpu => suggestedGpus.includes(gpu.id))); } catch { /* No live rate means no price. */ }
    }
    const suggestedModels = (catalog?.gpus ?? []).filter(gpu => suggestedGpus.includes(gpu.id))
      .map(gpu => ({ gpuId: gpu.id, modelId: gpu.modelId ?? null }));
    const actualModel = suggestedModels.find(gpu => gpu.gpuId === pricing?.gpuId)?.modelId ?? suggestedModels[0]?.modelId;
    if (taskType === "inference" && actualModel) sizing = { ...sizing, model: actualModel };
    res.json({ source, taskType, modelId, region: "us-east-2", latencyMs: Date.now() - started,
      sizing, suggestedGpus, suggestedModels, pricing, availability: suggestedGpus.length ? "available" : taskType === "inference" ? "offline" : "unsupported" });
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

function bookingRange(body: unknown, requireFuture = true) {
  const data = body as Record<string, unknown> | undefined;
  const gpuId = typeof data?.gpuId === "string" ? data.gpuId : "";
  if (!/^gpu-[a-h]$/.test(gpuId)) throw new TaskError("BAD_REQUEST", "gpuId is invalid.");
  const start = typeof data?.slotStart === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.slotStart) ? Date.parse(data.slotStart) : NaN;
  const slotSeconds = SLOT_MINUTES * 60;
  if (!Number.isSafeInteger(slotSeconds) || slotSeconds <= 0) throw new TaskError("BOOKING_UNAVAILABLE", "The booking interval is not configured.", 503);
  const durationSeconds = integer(data?.durationSeconds, "durationSeconds", slotSeconds, 288 * slotSeconds);
  if (durationSeconds % slotSeconds) throw new TaskError("BAD_REQUEST", `durationSeconds must be a multiple of ${slotSeconds}.`);
  if (!Number.isFinite(start) || (requireFuture && (start <= consentClock() || start + durationSeconds * 1000 > consentClock() + 7 * 86400000))) {
    throw new TaskError("BAD_REQUEST", "The range must be in the future and end within seven days.");
  }
  return { gpuId, slotStart: new Date(start).toISOString(), durationSeconds };
}
function bookingTerms(body: unknown, requireFuture = true): BookingTerms {
  const range = bookingRange(body, requireFuture);
  const value = (body as Record<string, unknown>)?.priceCap;
  const cap = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(cap) || cap <= 0 || cap > 1000 || Math.floor(cap * 1e6) <= 0) throw new TaskError("BAD_REQUEST", "priceCap must be greater than zero and no more than 1000.");
  return { ...range, priceCap: (Math.floor(cap * 1e6 + 1e-8) / 1e6).toFixed(6) };
}
function bookingQuote(range: ReturnType<typeof bookingRange>) {
  const catalog = cachedRentalCatalog();
  if (!catalog) throw new TaskError("PRICING_UNAVAILABLE", "Live rental prices are not available yet.", 503);
  const gpu = catalog.gpus.find(item => item.id === range.gpuId);
  if (!gpu) throw new TaskError("NOT_FOUND", "This GPU is not online.", 404);
  if (gpu.vcpu === null || gpu.ramGb === null || gpu.storageGb === null) throw new TaskError("BOOKING_UNAVAILABLE", "Hardware limits are not available.", 503);
  return buildQuote({ gpuId: range.gpuId, gpus: 1, vcpu: gpu.vcpu, ramGb: gpu.ramGb, storageGb: gpu.storageGb,
    durationSeconds: range.durationSeconds, mode: "balanced" }, [gpu]);
}
tasksRouter.post("/bookings/quote", (req, res) => {
  try {
    const range = bookingRange(req.body);
    const quote = bookingQuote(range);
    res.json({ ...range, slotEnd: new Date(Date.parse(range.slotStart) + range.durationSeconds * 1000).toISOString(),
      totalPrice: quote.totalPrice, pricePerHour: quote.pricePerHour,
      priceCap: (Math.ceil(Number(quote.totalPrice) * 1.1 * 1e6) / 1e6).toFixed(6), updatedAt: quote.updatedAt });
  } catch (error) { fail(res, error); }
});
tasksRouter.post("/bookings/challenge", (req, res) => {
  try {
    const identity = bookingIdentity(req);
    if (!liveEnabled()) throw new TaskError("BOOKING_UNAVAILABLE", "Live reservations are not enabled.", 503);
    const terms = bookingTerms(req.body);
    const quote = bookingQuote(terms);
    if (Number(quote.totalPrice) > Number(terms.priceCap)) throw new TaskError("PRICE_CAP_EXCEEDED", "The current rental price exceeds your price cap.", 409);
    res.status(201).json(consents.issue(identity, terms, quote.totalPrice));
  } catch (error) { fail(res, error); }
});

tasksRouter.post("/bookings", async (req: Request, res: Response) => {
  try {
    const identity = bookingIdentity(req);
    const holder = identity.holder as ReturnType<typeof actorFor>;
    if (!liveEnabled()) throw new TaskError("BOOKING_UNAVAILABLE", "Live reservations are not enabled.", 503);
    const data = req.body as Record<string, unknown>;
    const terms = bookingTerms(data, false);
    const { gpuId, durationSeconds } = terms;
    const slotStart = Date.parse(terms.slotStart);
    const consent = consents.verify(identity, terms, data);
    const slotSeconds = SLOT_MINUTES * 60;
    const cap = Number(terms.priceCap);
    const idempotencyKey = req.header("Idempotency-Key") ?? consent.id;
    if (idempotencyKey !== consent.id) throw new TaskError("BOOKING_CONSENT_CHANGED", "This approval belongs to a different booking request.", 403);
    await serialized(gpuId, async () => {
      const existing = db.prepare("SELECT id,status,response FROM task_bookings WHERE holder=? AND idempotency_key=?").get(holder, idempotencyKey) as BookingRow | undefined;
      if (existing) {
        if (existing.status === "confirmed" && existing.response) { res.json(JSON.parse(existing.response)); return; }
        throw new TaskError("BOOKING_PENDING", "This reservation already exists or is awaiting reconciliation. Do not submit another payment.", 409);
      }
      bookingRange(terms);
      await requireRealGpu(gpuId);
      const quote = bookingQuote(terms);
      if (Number(quote.totalPrice) > cap) throw new TaskError("PRICE_CAP_EXCEEDED", "The current rental price exceeds your price cap.", 409);
      const redemptionId = `reservation_${randomUUID()}`;
      const start = new Date(slotStart).toISOString();
      const end = new Date(slotStart + durationSeconds * 1000).toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        consents.consume(consent);
        db.prepare("INSERT INTO task_bookings (id,holder,idempotency_key,gpu_id,slot_start,slot_end,amount,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(redemptionId, holder, idempotencyKey, gpuId, start, end, quote.totalPrice, "reserving", new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
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
        amount: quote.totalPrice, currency: "TDX", priceSource: quote.priceSource, priceBasis: quote.priceBasis, priceUpdatedAt: quote.updatedAt, payment };
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

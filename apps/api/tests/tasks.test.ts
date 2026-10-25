import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { buildQuote, fallbackSizing, hourlyBlocks, parseEstimate, parseQuote, parseSizing, settleHeldBooking, TaskError, type RentalOffer } from "../src/routes/tasksCore.js";

const now = Date.parse("2026-10-25T08:00:00Z");
const offer: RentalOffer = { id: "gpu-a", vcpu: 4, ramGb: 16, storageGb: 50,
  prices: { rentalUsdPerHour: "0.125", economy: { updatedAt: new Date(now - 1000).toISOString() } },
  nodes: { total: 1, free: 1 } };
const input = { gpuId: "gpu-a", gpus: 1, vcpu: 2, ramGb: 4, storageGb: 10, durationSeconds: 3600, mode: "balanced" as const };

function rejects(code: string, run: () => unknown) {
  assert.throws(run, error => error instanceof TaskError && error.code === code);
}

test("quotes derive the entire total and cap only from the live rate", () => {
  const quote = buildQuote(input, [offer], now);
  assert.equal(quote.pricePerHour, "0.125000");
  assert.equal(quote.totalPrice, "0.125000");
  assert.equal(quote.priceCap, "0.125000");
  assert.equal(quote.updatedAt, offer.prices.economy!.updatedAt);
  assert.equal(buildQuote({ ...input, durationSeconds: 5400 }, [offer], now).totalPrice, "0.187500");
});

test("fractional ledger amounts round the cap up rather than undercharge", () => {
  const quote = buildQuote({ ...input, durationSeconds: 61 }, [offer], now);
  assert.equal(quote.totalPrice, "0.002119");
});

test("all modes keep the estimated duration without invented speedups", () => {
  const quote = buildQuote(input, [offer], now);
  assert.deepEqual(quote.options.map(option => option.mode), ["cheapest", "balanced", "fastest"]);
  assert(quote.options.every(option => option.estimatedDurationSeconds === 3600));
});

test("the quote path handles slider updates well within 150 milliseconds", () => {
  const started = performance.now();
  for (let index = 0; index < 1000; index++) buildQuote(input, [offer], now);
  assert(performance.now() - started < 150);
});

test("quotes fail closed on absent, invalid, future, or stale live feed rates", () => {
  for (const rate of [null, "0", "-1", "not-a-number"]) {
    rejects("PRICING_UNAVAILABLE", () => buildQuote(input, [{ ...offer, prices: { ...offer.prices, rentalUsdPerHour: rate } }], now));
  }
  for (const time of [now - 49 * 3600000, now + 6 * 60000]) {
    rejects("PRICING_UNAVAILABLE", () => buildQuote(input, [{ ...offer, prices: { ...offer.prices, economy: { updatedAt: new Date(time).toISOString() } } }], now));
  }
});

test("quotes cannot multiply one physical node or exceed its included resources", () => {
  for (const change of [{ gpus: 2 }, { vcpu: 5 }, { ramGb: 17 }, { storageGb: 51 }]) {
    rejects("NO_COMPATIBLE_GPU", () => buildQuote({ ...input, ...change }, [offer], now));
  }
  rejects("NO_COMPATIBLE_GPU", () => buildQuote(input, [{ ...offer, ramGb: null }], now));
  rejects("NO_COMPATIBLE_GPU", () => buildQuote(input, [], now));
});

test("sizing and sliders reject out of range, coercible or fractional numbers", () => {
  for (const change of [{ gpus: 0 }, { vcpu: 129 }, { ramGb: -1 }, { storageGb: 10001 }, { durationSeconds: 604801 }, { gpus: true }, { gpus: "1" }, { vcpu: 1.5 }]) {
    rejects("BAD_REQUEST", () => parseQuote({ ...input, ...change }));
  }
  assert.deepEqual(parseQuote(input), input);
});

test("descriptions and task types are validated before services are contacted", () => {
  rejects("BAD_REQUEST", () => parseEstimate({ description: " " }));
  rejects("BAD_REQUEST", () => parseEstimate({ description: "a".repeat(10001) }));
  rejects("BAD_REQUEST", () => parseEstimate({ description: "work", type: "unknown" }));
  assert.deepEqual(parseEstimate({ description: " Summarize " }), { description: "Summarize", type: "inference" });
});

test("API fallback sizing stays deterministic and uses only the deployed inference model", () => {
  const expected = { gpus: 1, vcpu: 2, ramGb: 4, storageGb: 10, durationSeconds: 60, model: "Qwen/Qwen2.5-1.5B-Instruct" };
  assert.deepEqual(fallbackSizing("Summarize a short document", "inference"), expected);
  assert.deepEqual(parseSizing(expected, "inference"), expected);
  rejects("BAD_REQUEST", () => parseSizing({ ...expected, model: "Qwen/Qwen3-1.7B" }, "inference"));
  rejects("BAD_REQUEST", () => parseSizing({ ...expected, gpus: 99 }, "inference"));
});

test("hourly calendar includes empty hours and actual interval overlap", () => {
  const from = Date.parse("2026-10-25T08:00:00Z");
  const blocks = hourlyBlocks([
    { start: "2026-10-25T08:30:00Z", end: "2026-10-25T09:30:00Z", kind: "BOOKED", ref: "paid-reservation" },
    { start: "2026-10-25T09:40:00Z", end: "2026-10-25T09:50:00Z", kind: "INFERENCE", ref: "running-task" },
  ], from, from + 3 * 3600000);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map(block => block.bookedMinutes), [30, 30, 0]);
  assert.deepEqual(blocks.map(block => block.runningMinutes), [0, 10, 0]);
  assert.deepEqual(blocks.map(block => block.status), ["booked", "booked", "free"]);
});

test("calendar overlap is merged instead of counting the same minute twice", () => {
  const blocks = hourlyBlocks([
    { start: "2026-10-25T08:00:00Z", end: "2026-10-25T08:45:00Z", kind: "INFERENCE", ref: "a" },
    { start: "2026-10-25T08:15:00Z", end: "2026-10-25T09:00:00Z", kind: "INFERENCE", ref: "b" },
  ], now, now + 3600000);
  assert.equal(blocks[0].runningMinutes, 60);
  assert.deepEqual(blocks[0].refs, ["a", "b"]);
});

test("a validated rejected payment releases the GPU hold and never confirms", async () => {
  let released = false;
  await assert.rejects(settleHeldBooking({
    charge: async () => ({ hash: "rejected", validated: true, result: "tecUNFUNDED_PAYMENT" }),
    release: async () => { released = true; },
    pending: () => assert.fail("A validated rejection is conclusive"),
  }), error => error instanceof TaskError && error.code === "PAYMENT_FAILED");
  assert(released);
});

test("an uncertain payment is journaled and keeps its hold to prevent double payment", async () => {
  let pendingHash: string | null | undefined;
  await assert.rejects(settleHeldBooking({
    charge: async () => ({ hash: "submitted", validated: false, result: "tesSUCCESS" }),
    release: async () => assert.fail("Do not release a potentially paid reservation"),
    pending: hash => { pendingHash = hash; },
  }), error => error instanceof TaskError && error.code === "PAYMENT_PENDING");
  assert.equal(pendingHash, "submitted");
});

test("an interrupted ledger request never claims payment success or blindly retries", async () => {
  let markedPending = false;
  await assert.rejects(settleHeldBooking({
    charge: async () => { throw new Error("Connection interrupted after submission"); },
    release: async () => assert.fail("The ledger outcome is unknown"),
    pending: hash => { markedPending = true; assert.equal(hash, null); },
  }), error => error instanceof TaskError && error.code === "PAYMENT_PENDING");
  assert(markedPending);
});

test("only a validated successful payment confirms a prepaid reservation", async () => {
  const payment = { hash: "validated-payment", validated: true, result: "tesSUCCESS" };
  assert.deepEqual(await settleHeldBooking({
    charge: async () => payment,
    release: async () => assert.fail("A paid reservation must be retained"),
    pending: () => assert.fail("The payment is already validated"),
  }), payment);
});

// These exercise actual Express handlers while replacing every external boundary.
// No test reaches a real ledger, compute worker, price feed, or AWS account.
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { createTasksRouter, type TaskRouteDependencies } from "../src/routes/tasks.js";
import type { RentalCatalog } from "../src/marketData/rentalCatalog.js";

type RouteOptions = {
  paymentResult?: string; paymentValidated?: boolean; paymentThrows?: boolean;
  reserveRejects?: boolean; reserveResponseLost?: boolean; cancelFails?: boolean;
  paidRecordFails?: boolean; pendingRecordFails?: boolean;
};
async function routeFixture(options: RouteOptions = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE bookings (id TEXT PRIMARY KEY,gpu_id TEXT,slot_start TEXT,slot_end TEXT,holder TEXT,redemption_id TEXT)`);
  const state = { charges: 0, reservations: 0, cancellations: 0, holder: "", amount: "", emitted: [] as string[] };
  const fresh = new Date().toISOString();
  const catalog = { updatedAt: fresh, gpus: [{ ...offer, prices: { ...offer.prices, economy: { updatedAt: fresh } } }] } as RentalCatalog;
  const db = options.pendingRecordFails ? new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (state.charges && sql.startsWith("UPDATE task_bookings")) throw new Error("Journal disk unavailable after submission");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) : database;
  const fetchUpstream: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health") return Response.json({ mock: false });
    if (path === "/gpus") return Response.json([{ id: "gpu-a", state: "READY", simulated: false }]);
    if (path === "/bookings" && init?.method === "POST") {
      state.reservations++;
      if (options.reserveRejects) return Response.json({ error: { code: "SLOT_TAKEN" } }, { status: 409 });
      if (options.reserveResponseLost) throw new Error("Remote hold accepted but response interrupted");
      return Response.json({ booking_id: "upstream-booking" });
    }
    if (path === "/bookings/upstream-booking" && init?.method === "DELETE") {
      state.cancellations++;
      if (options.cancelFails) throw new Error("Cancellation acknowledgement unavailable");
      return Response.json({ status: "cancelled" });
    }
    if (path === "/gpus/gpu-a/calendar") {
      const from = Math.floor(Date.now() / 3600000) * 3600000;
      return Response.json([{ start: new Date(from).toISOString(), end: new Date(from + 1800000).toISOString(), kind: "BOOKED", ref: "real-upstream-reservation" }]);
    }
    assert.fail(`Unexpected upstream route: ${path}`);
  };
  const app = express();
  app.use(express.json());
  const dependencies: Partial<TaskRouteDependencies> = {
    db, cachedCatalog: () => catalog, getCatalog: async () => catalog,
    actor: req => { if (req.header("X-Test-Signed-Out")) throw new Error("No session"); return "DEV"; },
    liveEnabled: () => true, fetchUpstream,
    estimate: async () => { throw new Error("Pricing service unavailable"); },
    pay: async params => {
      state.charges++; state.holder = params.payer; state.amount = params.amount;
      if (options.paymentThrows) throw new Error("Ledger acknowledgement interrupted");
      return { hash: "injected-ledger-hash", validated: options.paymentValidated ?? true,
        result: options.paymentResult ?? "tesSUCCESS", explorerUrl: "https://example.invalid/transaction" };
    },
    addRevenue: () => { if (options.paidRecordFails) throw new Error("Local persistence failed after payment"); },
    logTx: () => {}, broadcast: type => { state.emitted.push(type); },
  };
  app.use(createTasksRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const body = { gpuId: "gpu-a", slotStart: new Date(Date.now() + 3600000).toISOString(), durationSeconds: 3600, priceCap: "1.000000", holder: "ALEXANDER" };
  return {
    state, database, body,
    post: (path: string, payload: unknown, key = "same-request", extra: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...extra }, body: JSON.stringify(payload) }),
    get: (path: string) => fetch(`${base}${path}`),
    journal: () => database.prepare("SELECT * FROM task_bookings").get() as { status: string; booking_id: string | null; payment_hash: string | null },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); database.close(); },
  };
}

test("Express booking uses the signed actor, settles once, and replays confirmed idempotency", async () => {
  const fixture = await routeFixture();
  try {
    const response = await fixture.post("/bookings", fixture.body);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.amount, "0.125000");
    assert.equal(result.payment.validated, true);
    assert.equal(fixture.state.holder, "DEV");
    assert.equal(fixture.journal().status, "confirmed");
    const replay = await fixture.post("/bookings", fixture.body);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), result);
    assert.equal(fixture.state.charges, 1);
    assert.equal(fixture.state.reservations, 1);
    assert.deepEqual(fixture.state.emitted, ["calendar", "tx"]);
  } finally { await fixture.close(); }
});

test("Express booking never charges an unsigned account or exceeds the authorized cap", async () => {
  const fixture = await routeFixture();
  try {
    assert.equal((await fixture.post("/bookings", fixture.body, "unsigned", { "X-Test-Signed-Out": "1" })).status, 401);
    const response = await fixture.post("/bookings", { ...fixture.body, priceCap: "0.001" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "PRICE_CAP_EXCEEDED");
    assert.equal(fixture.state.charges, 0);
    assert.equal(fixture.state.reservations, 0);
  } finally { await fixture.close(); }
});

test("Express overlap rejection performs no ledger payment", async () => {
  const fixture = await routeFixture({ reserveRejects: true });
  try {
    const response = await fixture.post("/bookings", fixture.body);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "SLOT_TAKEN");
    assert.equal(fixture.state.charges, 0);
    assert.equal(fixture.journal().status, "cancelled");
  } finally { await fixture.close(); }
});

test("Express lost reservation acknowledgement journals uncertainty without charging", async () => {
  const fixture = await routeFixture({ reserveResponseLost: true });
  try {
    assert.equal((await fixture.post("/bookings", fixture.body)).status, 503);
    assert.equal(fixture.state.charges, 0);
    assert.equal(fixture.journal().status, "reservation_pending");
    assert.equal((await fixture.post("/bookings", fixture.body)).status, 409);
    assert.equal(fixture.state.reservations, 1);
  } finally { await fixture.close(); }
});

test("Express failed payment releases its compute hold", async () => {
  const fixture = await routeFixture({ paymentResult: "tecUNFUNDED_PAYMENT" });
  try {
    const response = await fixture.post("/bookings", fixture.body);
    assert.equal(response.status, 402);
    assert.equal((await response.json()).error.code, "PAYMENT_FAILED");
    assert.equal(fixture.state.cancellations, 1);
    assert.equal(fixture.journal().status, "cancelled");
    assert.deepEqual(fixture.state.emitted, []);
  } finally { await fixture.close(); }
});

test("Express failed cancellation remains pending and never claims the slot was released", async () => {
  const fixture = await routeFixture({ paymentResult: "tecUNFUNDED_PAYMENT", cancelFails: true });
  try {
    const response = await fixture.post("/bookings", fixture.body);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error.code, "CANCELLATION_PENDING");
    assert.match(result.error.message, /Do not submit another payment/);
    assert.equal(fixture.journal().status, "cancellation_pending");
    assert.deepEqual(fixture.state.emitted, []);
  } finally { await fixture.close(); }
});

test("Express paid reservation with failed local commit stays pending and cannot charge twice", async () => {
  const fixture = await routeFixture({ paidRecordFails: true });
  try {
    const response = await fixture.post("/bookings", fixture.body);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error.code, "BOOKING_PENDING");
    assert.match(result.error.message, /payment was confirmed/);
    assert.equal(fixture.journal().status, "payment_pending");
    assert.equal(fixture.journal().payment_hash, "injected-ledger-hash");
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM bookings").get()?.count, 0);
    assert.equal((await fixture.post("/bookings", fixture.body)).status, 409);
    assert.equal(fixture.state.charges, 1);
    assert.equal(fixture.state.cancellations, 0);
  } finally { await fixture.close(); }
});

for (const paymentThrows of [false, true]) {
  test(`Express pending journal failure preserves do-not-pay-again after ${paymentThrows ? "transport interruption" : "unvalidated payment"}`, async () => {
    const fixture = await routeFixture({ paymentValidated: false, paymentThrows, pendingRecordFails: true });
    try {
      const response = await fixture.post("/bookings", fixture.body);
      assert.equal(response.status, 503);
      const result = await response.json();
      assert.equal(result.error.code, "PAYMENT_PENDING");
      assert.match(result.error.message, /Do not pay again/);
      assert.equal(fixture.journal().status, "payment_pending");
      assert.equal((await fixture.post("/bookings", fixture.body)).status, 409);
      assert.equal(fixture.state.charges, 1);
    } finally { await fixture.close(); }
  });
}

test("Express quote calendar and offline estimator preserve upstream truth", async () => {
  const fixture = await routeFixture();
  try {
    const quote = await fixture.post("/tasks/quote", input);
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).totalPrice, "0.125000");
    const estimate = await fixture.post("/tasks/estimate", { description: "Summarize", type: "inference" });
    assert.equal(estimate.status, 200);
    const sizing = await estimate.json();
    assert.equal(sizing.source, "fallback");
    assert.equal(sizing.sizing.model, "Qwen/Qwen2.5-1.5B-Instruct");
    const calendar = await fixture.get("/gpus/gpu-a/calendar?days=1");
    assert.equal(calendar.status, 200);
    const schedule = await calendar.json();
    assert.equal(schedule.blocks.length, 24);
    assert.equal(schedule.blocks[0].bookedMinutes, 30);
    assert.deepEqual(schedule.blocks[0].refs, ["real-upstream-reservation"]);
    assert.equal(fixture.state.charges, 0);
  } finally { await fixture.close(); }
});

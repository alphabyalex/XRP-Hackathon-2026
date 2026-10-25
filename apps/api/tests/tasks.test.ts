import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { buildQuote, fallbackSizing, hourlyBlocks, parseEstimate, parseQuote, parseSizing, settleHeldBooking, TaskError, type RentalOffer } from "../src/routes/tasksCore.js";

const now = Date.parse("2026-10-25T08:00:00Z");
const offer: RentalOffer = { id: "gpu-a", vcpu: 4, ramGb: 16, storageGb: 50,
  prices: { rentalUsdPerHour: "0.125", rental: { usdPerHour: "0.125", updatedAt: new Date(now - 1000).toISOString(), source: "Akash lease plus margin", priceBasis: "akash_lease_plus_margin", expiresAt: null, costUsdPerHour: "0.1", marginPct: "25" }, economy: { updatedAt: new Date(now - 1000).toISOString() } },
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
  assert.equal(quote.updatedAt, offer.prices.rental!.updatedAt);
  assert.equal(buildQuote({ ...input, durationSeconds: 5400 }, [offer], now).totalPrice, "0.187500");
});

test("fractional ledger amounts round the cap up rather than undercharge", () => {
  const quote = buildQuote({ ...input, durationSeconds: 61 }, [offer], now);
  assert.equal(quote.totalPrice, "0.002119");
});

test("no mode is faster than the estimate; pausable Cheapest is estimated 30% longer", () => {
  const quote = buildQuote(input, [offer], now);
  assert.deepEqual(quote.options.map(option => option.mode), ["cheapest", "balanced", "fastest"]);
  const byMode = Object.fromEntries(quote.options.map(option => [option.mode, option.estimatedDurationSeconds]));
  assert.deepEqual(byMode, { cheapest: 4680, balanced: 3600, fastest: 3600 });
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
  for (const time of [NaN, now + 6 * 60000]) {
    rejects("PRICING_UNAVAILABLE", () => buildQuote(input, [{ ...offer, prices: { ...offer.prices, rental: { ...offer.prices.rental!, updatedAt: Number.isFinite(time) ? new Date(time).toISOString() : "invalid" } } }], now));
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
import { Wallet } from "xrpl";
import { sign } from "ripple-keypairs";
import { promptFunding } from "../src/middleware/funding.js";
import { createTasksRouter, type TaskRouteDependencies } from "../src/routes/tasks.js";
import type { RentalCatalog } from "../src/marketData/rentalCatalog.js";

type RouteOptions = {
  paymentResult?: string; paymentValidated?: boolean; paymentThrows?: boolean;
  reserveRejects?: boolean; reserveResponseLost?: boolean; cancelFails?: boolean;
  paidRecordFails?: boolean; pendingRecordFails?: boolean;
  catalogGpuId?: string; catalogModelId?: string;
  fundingBalance?: string;
};
async function routeFixture(options: RouteOptions = {}) {
  const wallet = Wallet.generate();
  const account = Wallet.generate().classicAddress;
  let clock = Date.now();
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE bookings (id TEXT PRIMARY KEY,gpu_id TEXT,slot_start TEXT,slot_end TEXT,holder TEXT,redemption_id TEXT)`);
  const state = { charges: 0, reservations: 0, cancellations: 0, holder: "", amount: "", emitted: [] as string[] };
  const fresh = new Date().toISOString();
  const catalog = { updatedAt: fresh, gpus: [{ ...offer, id: options.catalogGpuId ?? offer.id,
    modelId: options.catalogModelId,
    prices: { ...offer.prices, rental: { ...offer.prices.rental!, updatedAt: fresh }, economy: { updatedAt: fresh } } }] } as RentalCatalog;
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
  app.use((req, _res, next) => {
    if (!req.header("X-Test-Signed-Out")) req.user = { name: "DEV", wallet: wallet.classicAddress,
      walletNetwork: "testnet", address: account, createdAt: fresh };
    next();
  });
  const dependencies: Partial<TaskRouteDependencies> = {
    db, cachedCatalog: () => catalog, getCatalog: async () => catalog,
    actor: req => { if (req.header("X-Test-Signed-Out")) throw new Error("No session"); return "DEV"; },
    bookingIdentity: req => { if (req.header("X-Test-Signed-Out")) throw new TaskError("NOT_CONNECTED", "No session", 401); return { holder: "DEV", wallet: wallet.classicAddress, account }; },
    consentClock: () => clock,
    funding: promptFunding(async () => ({ balance: options.fundingBalance ?? "1", balanceUpdatedAt: fresh })),
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
  const proofs = new Map<string, Record<string, unknown>>();
  const rawPost = (path: string, payload: unknown, key?: string, extra: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...extra }, body: JSON.stringify(payload),
  });
  async function post(path: string, payload: unknown, key = "same-request", extra: Record<string, string> = {}) {
    if (path !== "/bookings") return rawPost(path, payload, key, extra);
    let proof = proofs.get(key);
    if (!proof) {
      const response = await rawPost("/bookings/challenge", payload, undefined, extra);
      if (!response.ok) return response;
      const challenge = await response.json();
      proof = { ...payload as object, challengeId: challenge.challengeId, publicKey: wallet.publicKey, signature: sign(challenge.messageHex, wallet.privateKey) };
      proofs.set(key, proof);
    }
    return rawPost(path, proof, String(proof.challengeId), extra);
  }
  return {
    state, database, body,
    post, rawPost, proofs, wallet, account, advance: (ms: number) => { clock += ms; },
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

test("own 0.200 policy stays distinct from the 0.550 market comparison and matches all mode rates", () => {
  const own = { ...offer, prices: { ...offer.prices, rentalUsdPerHour: "0.200000",
    rental: { ...offer.prices.rental!, usdPerHour: "0.200000", costUsdPerHour: "0.160000" },
    economy: { updatedAt: new Date(now - 49 * 3600_000).toISOString() },
    awsSpot: { usdPerHour: "0.250000", updatedAt: new Date(now - 1000).toISOString() },
    awsOnDemand: { usdPerHour: "0.500000", updatedAt: new Date(now - 1000).toISOString() } } };
  const quote = buildQuote(input, [own], now);
  assert.deepEqual(quote.options.map(item => item.pricePerHour), ["0.100000", "0.150000", "0.200000"]);
  assert.equal(quote.priceSource, "Akash lease plus margin");
  assert.equal(quote.priceBasis, "akash_lease_plus_margin");
  assert(!quote.formula.includes("GPU Economy hourly median"));
  const expiredSpot = { ...own, prices: { ...own.prices, awsSpot: { ...own.prices.awsSpot!, updatedAt: new Date(now - 31 * 60_000).toISOString() } } };
  assert.deepEqual(buildQuote(input, [expiredSpot], now).options.map(item => item.pricePerHour), ["0.200000", "0.200000", "0.200000"]);
  const future = { ...own, prices: { ...own.prices, awsSpot: { ...own.prices.awsSpot!, updatedAt: new Date(now + 5 * 60_000).toISOString() } } };
  assert.equal(buildQuote(input, [future], now).awsDiscountRatio, null);
});

test("inference estimates identify the model actually deployed on the priced physical node", async () => {
  const fixture = await routeFixture({ catalogGpuId: "gpu-c", catalogModelId: "Qwen/Qwen2.5-3B-Instruct" });
  try {
    const response = await fixture.post("/tasks/estimate", { description: "Summarize this report", type: "inference" });
    assert.equal(response.status, 200);
    const estimate = await response.json();
    assert.equal(estimate.sizing.model, "Qwen/Qwen2.5-3B-Instruct");
    assert.equal(estimate.pricing.gpuId, "gpu-c");
    assert.deepEqual(estimate.suggestedModels, [{ gpuId: "gpu-c", modelId: "Qwen/Qwen2.5-3B-Instruct" }]);
    assert.equal(fixture.state.charges, 0);
  } finally { await fixture.close(); }
});

test("booking range quote uses the full live duration before any hold or payment", async () => {
  const fixture = await routeFixture();
  try {
    const response = await fixture.post("/bookings/quote", { ...fixture.body, durationSeconds: 7200 });
    assert.equal(response.status, 200);
    const quote = await response.json();
    assert.equal(quote.totalPrice, "0.250000");
    assert.equal(Date.parse(quote.slotEnd) - Date.parse(quote.slotStart), 7200000);
    assert.equal(fixture.state.charges + fixture.state.reservations, 0);
  } finally { await fixture.close(); }
});

async function signedBooking(fixture: Awaited<ReturnType<typeof routeFixture>>) {
  const response = await fixture.post("/bookings/challenge", fixture.body);
  assert.equal(response.status, 201);
  const challenge = await response.json();
  return { challenge, proof: { ...fixture.body, challengeId: challenge.challengeId,
    publicKey: fixture.wallet.publicKey, signature: sign(challenge.messageHex, fixture.wallet.privateKey) } };
}

test("wallet consent binds purpose, GPU, both times, cap and the session account", async () => {
  const fixture = await routeFixture();
  try {
    const { challenge, proof } = await signedBooking(fixture);
    for (const text of ["Moonshift GPU booking consent v1", "Nonce:", fixture.wallet.classicAddress,
      fixture.account, fixture.body.gpuId, fixture.body.slotStart, challenge.slotEnd, "1.000000 USDC"]) assert(challenge.message.includes(text));
    for (const change of [{ gpuId: "gpu-b" }, { slotStart: new Date(Date.parse(fixture.body.slotStart) + 3600000).toISOString() },
      { durationSeconds: 7200 }, { priceCap: "2.000000" }]) {
      const response = await fixture.rawPost("/bookings", { ...proof, ...change }, challenge.challengeId);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "BOOKING_CONSENT_CHANGED");
    }
    assert.equal(fixture.state.charges + fixture.state.reservations, 0);
  } finally { await fixture.close(); }
});

test("wrong wallet signatures and changed signature bytes never reserve or charge", async () => {
  const fixture = await routeFixture();
  try {
    const { challenge, proof } = await signedBooking(fixture);
    const other = Wallet.generate();
    for (const change of [{ publicKey: other.publicKey, signature: sign(challenge.messageHex, other.privateKey) },
      { signature: `${proof.signature.startsWith("A") ? "B" : "A"}${proof.signature.slice(1)}` }]) {
      const response = await fixture.rawPost("/bookings", { ...proof, ...change }, challenge.challengeId);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "INVALID_BOOKING_SIGNATURE");
    }
    assert.equal(fixture.state.charges + fixture.state.reservations, 0);
  } finally { await fixture.close(); }
});

test("expired unused wallet approvals leave no hold, payment or consumed nonce", async () => {
  const fixture = await routeFixture();
  try {
    const { challenge, proof } = await signedBooking(fixture);
    fixture.advance(6 * 60000);
    const response = await fixture.rawPost("/bookings", proof, challenge.challengeId);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "BOOKING_CONSENT_EXPIRED");
    assert.equal(fixture.state.charges + fixture.state.reservations, 0);
    assert.equal(fixture.database.prepare("SELECT consumed_at FROM booking_consents").get()?.consumed_at, null);
    assert.equal(fixture.database.prepare("SELECT count(*) AS n FROM task_bookings").get()?.n, 0);
  } finally { await fixture.close(); }
});

test("a consent cannot be moved to a new idempotency request or reused after consuming", async () => {
  const fixture = await routeFixture();
  try {
    const { challenge, proof } = await signedBooking(fixture);
    const moved = await fixture.rawPost("/bookings", proof, "another-request");
    assert.equal(moved.status, 403);
    fixture.database.prepare("UPDATE booking_consents SET consumed_at=? WHERE id=?").run(new Date().toISOString(), challenge.challengeId);
    const replay = await fixture.rawPost("/bookings", proof, challenge.challengeId);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, "BOOKING_CONSENT_USED");
    assert.equal(fixture.state.charges + fixture.state.reservations, 0);
  } finally { await fixture.close(); }
});

test("parallel identical signed requests settle exactly once and retain the signature audit", async () => {
  const fixture = await routeFixture();
  try {
    const { challenge, proof } = await signedBooking(fixture);
    const responses = await Promise.all([fixture.rawPost("/bookings", proof, challenge.challengeId), fixture.rawPost("/bookings", proof, challenge.challengeId)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    assert.equal(fixture.state.charges, 1);
    assert.equal(fixture.state.reservations, 1);
    const row = fixture.database.prepare("SELECT consumed_at,public_key,signature FROM booking_consents").get();
    assert(row?.consumed_at);
    assert.equal(row?.public_key, proof.publicKey);
    assert.equal(row?.signature, proof.signature);
    fixture.advance(8 * 86400000);
    const recovered = await fixture.rawPost("/bookings", proof, challenge.challengeId);
    assert.equal(recovered.status, 200); // A completed receipt remains recoverable after approval expiry.
    assert.equal(fixture.state.charges, 1);
  } finally { await fixture.close(); }
});

test("task estimator rejects anonymous or unfunded prompts before any service call", async () => {
  const anonymous = await routeFixture();
  const unfunded = await routeFixture({ fundingBalance: "0" });
  try {
    const first = await anonymous.post("/tasks/estimate", { description: "Size a task", type: "inference" }, "unsigned", { "X-Test-Signed-Out": "1" });
    assert.equal(first.status, 401);
    const second = await unfunded.post("/tasks/estimate", { description: "Size a task", type: "inference" });
    assert.equal(second.status, 402);
    assert.equal((await second.json()).error.code, "USDC_REQUIRED");
  } finally { await anonymous.close(); await unfunded.close(); }
});

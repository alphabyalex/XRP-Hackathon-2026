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

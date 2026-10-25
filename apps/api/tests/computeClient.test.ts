import test from "node:test";
import assert from "node:assert/strict";
import * as compute from "../src/adapters/computeClient.js";

test("compute failures cannot become a successful reply, booking, schedule or telemetry", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const operations = [
      () => compute.getGpus(),
      () => compute.getCalendar("gpu-a", "2026-10-25T09:00:00Z", "2026-10-25T10:00:00Z"),
      () => compute.createBooking({ gpu_id: "gpu-a", slot_start: "2026-10-25T09:00:00Z", slots: 1, holder: "DEV", redemption_id: "reservation" }),
      () => compute.chatCompletions({ messages: [{ role: "user", content: "hello" }] }, "DEV"),
      () => compute.getRevenueHistory("gpu-a"),
      () => compute.getMonteCarloStatus(),
      () => compute.runSwitchDemo(),
    ];
    for (const operation of operations) {
      await assert.rejects(operation, (error: unknown) => error instanceof compute.ComputeError && error.status === 503);
    }
  } finally { globalThis.fetch = original; }
});

test("reservation conflict remains a conflict instead of creating a local booking", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "SLOT_TAKEN" } }), { status: 409 });
  try {
    await assert.rejects(
      () => compute.createBooking({ gpu_id: "gpu-a", slot_start: "2026-10-25T09:00:00Z", slots: 1, holder: "DEV", redemption_id: "reservation" }),
      (error: unknown) => error instanceof compute.ComputeError && error.status === 409,
    );
  } finally { globalThis.fetch = original; }
});

test("unmetered revenue and synthetic GPU rows never appear as live measured results", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes("/revenue?")
    ? [{ revenue: null, revenueAvailable: false, start: "2026-10-25T08:00:00Z", end: "2026-10-25T09:00:00Z" }]
    : [{ id: "gpu-a", simulated: false }, { id: "gpu-b", simulated: true }]));
  try {
    assert.deepEqual((await compute.getGpus()).map(gpu => gpu.id), ["gpu-a"]);
    assert.deepEqual(await compute.getRevenueHistory("gpu-a"), { buckets: [], source: "live" });
  } finally { globalThis.fetch = original; }
});

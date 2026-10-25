import test from "node:test";
import assert from "node:assert/strict";
import { holdingPerformance, ownedGpuIds, readHoldingTelemetry } from "../src/accountTelemetry.js";
import type { CalendarEntry, RevenueBucket } from "@moonshift/shared";

const now = Date.parse("2026-10-25T16:00:00Z");
function bucket(start: string, revenue = "0.125000"): RevenueBucket {
  return { start, end: new Date(Date.parse(start) + 3600000).toISOString(), revenue,
    bookedMinutes: 1, inferenceMinutes: 2, idleMinutes: 57, utilizationPct: "5.000000", simulated: false };
}

test("seven actual owned GPUs survive unavailable worker calendars and revenue", async () => {
  const registry = "abcdfgh".split("").map(letter => ({ id: `gpu-${letter}`, shareCode: `share-${letter}` }));
  const tokens = Object.fromEntries(registry.map(gpu => [gpu.shareCode, "2.500000"]));
  const ids = ownedGpuIds(registry, tokens, []);
  assert.deepEqual(ids, registry.map(gpu => gpu.id), "Ownership never depends on worker health");
  const calendar: CalendarEntry[] = [{ start: "2026-10-25T14:00:00Z", end: "2026-10-25T14:01:00Z", kind: "INFERENCE", ref: "actual-request" }];
  const rows = await readHoldingTelemetry(ids, {
    calendar: async id => { if (id === "gpu-g") throw Error("worker unavailable"); return calendar; },
    revenue: async id => { if (id === "gpu-h") throw Error("worker unavailable"); return { buckets: [bucket("2026-10-25T14:00:00Z")] }; },
  });
  assert.deepEqual(rows.map(row => row.gpuId), ids);
  assert.equal(rows.find(row => row.gpuId === "gpu-g")!.calendar, null);
  assert.equal(rows.find(row => row.gpuId === "gpu-h")!.history, null);
  assert.deepEqual(rows.find(row => row.gpuId === "gpu-h")!.calendar, calendar);
  assert.deepEqual(holdingPerformance("gpu-h", rows.find(row => row.gpuId === "gpu-h")!.history, now), {
    gpuId: "gpu-h", days: [], revenue24h: null, utilization24h: null, revenueAvailable: false, source: "unavailable",
  });
});

test("locked collateral remains a holding while unowned workers require no telemetry", () => {
  const registry = [{ id: "gpu-a", shareCode: "GPA" }, { id: "gpu-h", shareCode: "GPH" }];
  assert.deepEqual(ownedGpuIds(registry, {}, [{ gpuId: "gpu-h", status: "open", collateralShares: "1", ledger: { collateral: { locked: true } } }]), ["gpu-h"]);
  assert.deepEqual(ownedGpuIds(registry, {}, [{ gpuId: "gpu-h", status: "repaid", collateralShares: "1", ledger: null }]), []);
});

test("daily revenue preserves measured totals without assigning income to invented rate weights", () => {
  const out = holdingPerformance("gpu-a", { buckets: [bucket("2026-10-25T14:00:00Z", "0.300000"), bucket("2026-10-25T15:00:00Z", "0.200000")] }, now,
    [{ start: "2026-10-25T14:00:00Z", end: "2026-10-25T15:00:00Z" }]);
  assert.equal(out.revenue24h, "0.500000");
  assert.equal(out.days[0].revenue, "0.500000");
  assert.equal(out.days[0].booked, null); assert.equal(out.days[0].inference, null);
  assert.equal(out.utilization24h, "4.166667");
});

test("sparse old measurements are not mislabeled as 24-hour revenue and missing data is not zero", () => {
  const out = holdingPerformance("gpu-a", { buckets: [bucket("2026-10-22T14:00:00Z", "0.300000")] }, now);
  assert.equal(out.revenue24h, null); assert.equal(out.utilization24h, null);
  assert.equal(out.days[0].revenue, "0.300000");
  assert.equal(holdingPerformance("gpu-a", { buckets: [] }, now).revenue24h, null);
  assert.equal(holdingPerformance("gpu-a", { buckets: [bucket("2026-10-25T14:00:00Z", "0")] }, now).revenue24h, "0.000000");
});

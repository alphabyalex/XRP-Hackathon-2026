import test from "node:test";
import assert from "node:assert/strict";
import { filterLoanBook, lendingRangePoints, recordedLoan } from "../src/lib/lendingHistory";

test("timeframe controls filter actual observations without adding boundary or zero points", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const points = [0.5, 2, 12, 48, 192].map(hours => ({ t: now - hours * 3600000, v: hours }));
  assert.deepEqual(lendingRangePoints(points, "1h", now).map(p => p.v), [0.5]);
  assert.deepEqual(lendingRangePoints(points, "6h", now).map(p => p.v), [2, 0.5]);
  assert.deepEqual(lendingRangePoints(points, "24h", now).map(p => p.v), [12, 2, 0.5]);
  assert.deepEqual(lendingRangePoints(points, "7d", now).map(p => p.v), [48, 12, 2, 0.5]);
  assert.equal(lendingRangePoints(points, "7d", now).at(-1), points[0]);
});

test("borrower, GPU and state filters compose and sorting preserves the source array", () => {
  const rows = [{ id: "first", borrower: "rAlice", gpuId: "gpu-a", state: "open", principal: 50, outstanding: 20, apr: 0.1, openedAt: "2026-10-24T12:00:00Z" },
    { id: "second", borrower: "rBob", gpuId: "gpu-b", state: "repaid", principal: 100, outstanding: 0, apr: 0.05, openedAt: "2026-10-25T12:00:00Z" }];
  const filters = { search: "", gpu: "all", state: "all", sort: "principal" as const };
  assert.deepEqual(filterLoanBook(rows, filters).map(r => r.id), ["second", "first"]);
  assert.deepEqual(filterLoanBook(rows, { ...filters, state: "active" }).map(r => r.id), ["first"]);
  assert.deepEqual(filterLoanBook(rows, { ...filters, gpu: "gpu-b", search: "bob" }).map(r => r.id), ["second"]);
  assert.deepEqual(filterLoanBook(rows, { ...filters, state: "closed", search: "alice" }), []);
  assert.equal(rows[0].id, "first");
});

test("known legacy placeholders are hidden while real historical origination records remain", () => {
  const real = { id: "actual-old-loan", simulated: false, txs: { loanSet: "B".repeat(64) } };
  assert.equal(recordedLoan(real), true);
  assert.equal(recordedLoan({ ...real, id: "MOCK_A_DEV" }), false);
  assert.equal(recordedLoan({ ...real, simulated: true }), false);
  assert.equal(recordedLoan({ ...real, txs: { loanSet: "MOCK_A" } }), false);
});

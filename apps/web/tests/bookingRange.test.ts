import test from "node:test";
import assert from "node:assert/strict";
import { contiguousHours, freeHour } from "../src/lib/bookingRange";
import type { CalendarBlock } from "../src/lib/catalog";
const from = Date.parse("2026-11-01T00:00:00Z");
const hours = (count: number): CalendarBlock[] => Array.from({ length: count }, (_, index) => ({
  start: new Date(from + index * 3600000).toISOString(), end: new Date(from + (index + 1) * 3600000).toISOString(),
  bookedMinutes: 0, runningMinutes: 0, status: "free", refs: [],
}));

test("forward and backward drags select one contiguous inclusive range", () => {
  const blocks = hours(8);
  assert.deepEqual(contiguousHours(blocks, blocks[1].start, blocks[4].start, from - 1), blocks.slice(1, 5));
  assert.deepEqual(contiguousHours(blocks, blocks[4].start, blocks[1].start, from - 1), blocks.slice(1, 5));
  assert.equal(Date.parse(blocks[4].end) - Date.parse(blocks[1].start), 4 * 3600000);
});

test("an occupied hour or a missing timeline hour blocks the entire selection", () => {
  const blocks = hours(5);
  for (const change of [{ bookedMinutes: 1 }, { runningMinutes: 1 }, { status: "booked" }]) {
    const occupied = blocks.map((block, index) => index === 2 ? { ...block, ...change } : block);
    assert.deepEqual(contiguousHours(occupied, blocks[0].start, blocks[4].start, from - 1), []);
  }
  assert.deepEqual(contiguousHours([blocks[0], blocks[2]], blocks[0].start, blocks[2].start, from - 1), []);
});

test("current partial hours and unavailable endpoints are never bookable", () => {
  const blocks = hours(3);
  assert.equal(freeHour(blocks[0], from + 1), false);
  assert.deepEqual(contiguousHours(blocks, blocks[0].start, blocks[1].start, from + 1), []);
  assert.deepEqual(contiguousHours(blocks, "not-an-hour", blocks[1].start, from - 1), []);
});

test("UTC timeline preserves both real hours through the daylight saving clock change", () => {
  const blocks = hours(10);
  const repeated = blocks.slice(5, 7); // 01:00 appears twice in New York, but the UTC hours differ.
  assert.equal(new Date(repeated[0].start).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" }),
    new Date(repeated[1].start).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" }));
  assert.equal(contiguousHours(blocks, repeated[0].start, repeated[1].start, from - 1).length, 2);
});

test("selection enforces the 24 hour reservation limit", () => {
  const blocks = hours(25);
  assert.equal(contiguousHours(blocks, blocks[0].start, blocks[23].start, from - 1).length, 24);
  assert.deepEqual(contiguousHours(blocks, blocks[0].start, blocks[24].start, from - 1), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { availableBorrowTerm, borrowingInterest, borrowingScenarios } from "../src/lib/borrowingScenarios";
import { LendingReadCache, lendingInputKey } from "../src/lib/lendingCache";

const input = { sharePrice: 20, maxShares: 10, available: 1000, apr: 0.056,
  termSeconds: 30 * 86400, maxLtv: 0.35, principalPerShare: 6, seed: 17 };

test("each varied scenario uses the actual interest formula and stays within collateral and liquidity", () => {
  const points = borrowingScenarios(input);
  assert(points.length > 2);
  for (const point of points) {
    assert(point.shares >= 1 && point.shares <= input.maxShares);
    assert(point.principal <= input.available);
    assert(point.principal <= point.shares * input.principalPerShare);
    assert(point.ltv <= input.maxLtv);
    assert.equal(point.interest, borrowingInterest(point.principal, input.apr, input.termSeconds));
  }
  const slopes = points.slice(1).map((p, i) => (p.interest - points[i].interest) / (p.shares - points[i].shares));
  assert(new Set(slopes.map(slope => slope.toFixed(6))).size > 2, "Varied loan inputs produce a nonstraight cost curve");
});

test("shares, current rate, term and scenario inputs change quoted interest without inventing rate history", () => {
  const initial = borrowingScenarios(input);
  assert.deepEqual(borrowingScenarios(input), initial, "The same inputs are reproducible");
  assert.notDeepEqual(borrowingScenarios({ ...input, seed: 18 }), initial);
  assert.equal(borrowingScenarios({ ...input, apr: input.apr * 2 }).at(-1)!.interest, initial.at(-1)!.interest * 2);
  assert.equal(borrowingScenarios({ ...input, termSeconds: input.termSeconds / 2 }).at(-1)!.interest, initial.at(-1)!.interest / 2);
  assert(borrowingScenarios({ ...input, maxShares: 5 }).at(-1)!.interest < initial.at(-1)!.interest);
  assert(borrowingScenarios({ ...input, available: 1 }).every(p => p.principal <= 1));
});

test("missing money, holdings or source values produce no fabricated curve", () => {
  for (const values of [{ available: 0 }, { maxShares: 0 }, { sharePrice: NaN }, { termSeconds: 0 }, { apr: NaN }, { principalPerShare: 0 }]) {
    assert.deepEqual(borrowingScenarios({ ...input, ...values }), []);
  }
  assert.equal(borrowingScenarios({ ...input, maxShares: 1 }).length, 1);
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(availableBorrowTerm("2026-10-25T02:00:00Z", now), null);
  assert.equal(availableBorrowTerm("2026-10-30T00:00:00Z", now), 5 * 86400 - 3 * 3600);
});

test("read cache deduplicates concurrent input matches, expires briefly and never caches failures", async () => {
  let now = 0, calls = 0;
  const cache = new LendingReadCache(() => now);
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.read("same", 2000, load), cache.read("same", 2000, load)]), [1, 1]);
  assert.equal(await cache.read("same", 2000, load), 1);
  now = 2001;
  assert.equal(await cache.read("same", 2000, load), 2);
  await assert.rejects(cache.read("failed", 2000, async () => { throw new Error("offline"); }));
  assert.equal(await cache.read("failed", 2000, load), 3);
});

test("quote keys include wallet, GPU, shares, principal, term and source version", () => {
  const values = { gpuId: "gpu-a", collateralShares: "10", principal: "20", termSeconds: 86400 };
  const key = lendingInputKey("wallet-a", "/loans/quote", values, "source-a");
  assert.equal(key, lendingInputKey("wallet-a", "/loans/quote", { ...values, collateralShares: "10.0" }, "source-a"));
  for (const altered of [{ gpuId: "gpu-b" }, { collateralShares: "11" }, { principal: "21" }, { termSeconds: 86401 }])
    assert.notEqual(key, lendingInputKey("wallet-a", "/loans/quote", { ...values, ...altered }, "source-a"));
  assert.notEqual(key, lendingInputKey("wallet-b", "/loans/quote", values, "source-a"));
  assert.notEqual(key, lendingInputKey("wallet-a", "/loans/quote", values, "source-b"));
});

test("invalidation prevents an old pending session response from repopulating the cache", async () => {
  const cache = new LendingReadCache();
  let finish!: (value: string) => void;
  const old = cache.read("private", 2000, () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.read("private", 2000, async () => "new-user"), "new-user");
  finish("old-user");
  await old;
  assert.equal(await cache.read("private", 2000, async () => "incorrect"), "new-user");
});

import test from "node:test";
import assert from "node:assert/strict";
import { swr } from "../src/lending/swr.js";

test("swr serves fresh value without calling loader again", async () => {
  let loads = 0;
  const cache = swr<string>("test-fresh", 100, 500);

  const loader = async () => {
    loads++;
    return `value-${loads}`;
  };

  const v1 = await cache.get("k1", loader);
  assert.equal(v1, "value-1");
  assert.equal(loads, 1);

  const v2 = await cache.get("k1", loader);
  assert.equal(v2, "value-1");
  assert.equal(loads, 1);
});

test("swr concurrent callers share one load promise", async () => {
  let loads = 0;
  const cache = swr<string>("test-dedupe", 100, 500);

  const loader = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return `deduped-${loads}`;
  };

  const [res1, res2, res3] = await Promise.all([
    cache.get("k1", loader),
    cache.get("k1", loader),
    cache.get("k1", loader),
  ]);

  assert.equal(res1, "deduped-1");
  assert.equal(res2, "deduped-1");
  assert.equal(res3, "deduped-1");
  assert.equal(loads, 1);
});

test("swr serves stale entry while background refresh executes", async () => {
  let loads = 0;
  // fresh for 20ms, max stale for 200ms
  const cache = swr<string>("test-stale", 20, 200);

  const loader = async () => {
    loads++;
    return `data-${loads}`;
  };

  const first = await cache.get("k1", loader);
  assert.equal(first, "data-1");
  assert.equal(loads, 1);

  // Wait 30ms so it becomes stale but within maxStaleMs
  await new Promise((r) => setTimeout(r, 30));

  // Should immediately return stale data-1, while triggering background refresh
  const stale = await cache.get("k1", loader);
  assert.equal(stale, "data-1");

  // Allow background refresh to complete
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loads, 2);

  // Next call should get the refreshed data-2
  const refreshed = await cache.get("k1", loader);
  assert.equal(refreshed, "data-2");
});

test("swr invalidate forces immediate reload on next get", async () => {
  let loads = 0;
  const cache = swr<string>("test-invalidate", 500, 1000);

  const loader = async () => {
    loads++;
    return `gen-${loads}`;
  };

  const v1 = await cache.get("k1", loader);
  assert.equal(v1, "gen-1");
  assert.equal(loads, 1);

  cache.invalidate("k1");

  const v2 = await cache.get("k1", loader);
  assert.equal(v2, "gen-2");
  assert.equal(loads, 2);
});

test("swr global invalidate clears all keys", async () => {
  let loads = 0;
  const cache = swr<string>("test-global-invalidate", 500, 1000);

  const loader = async () => {
    loads++;
    return `global-${loads}`;
  };

  await cache.get("a", loader);
  await cache.get("b", loader);
  assert.equal(loads, 2);

  cache.invalidate();

  await cache.get("a", loader);
  assert.equal(loads, 3);
  await cache.get("b", loader);
  assert.equal(loads, 4);
});

test("swr keep filter prevents caching rejected values", async () => {
  let loads = 0;
  const cache = swr<{ status: string }>(
    "test-keep",
    100,
    500,
    (item) => item.status === "ok"
  );

  const loader = async () => {
    loads++;
    return { status: loads === 1 ? "error" : "ok" };
  };

  const first = await cache.get("k1", loader);
  assert.equal(first.status, "error");
  assert.equal(loads, 1);

  // Because keep returned false for error, k1 was not cached
  const second = await cache.get("k1", loader);
  assert.equal(second.status, "ok");
  assert.equal(loads, 2);

  // Now that it returned ok, keep returned true and it was cached
  const third = await cache.get("k1", loader);
  assert.equal(third.status, "ok");
  assert.equal(loads, 2);
});

test("swr preserves stale value if background refresh throws", async () => {
  let loads = 0;
  const cache = swr<string>("test-error-resilience", 20, 200);

  const loader = async () => {
    loads++;
    if (loads > 1) throw new Error("Network transient failure");
    return "stable-value";
  };

  const v1 = await cache.get("k1", loader);
  assert.equal(v1, "stable-value");

  await new Promise((r) => setTimeout(r, 30));

  // Should serve stale value and background reload fails silently
  const v2 = await cache.get("k1", loader);
  assert.equal(v2, "stable-value");
});

test('a persisted real snapshot seeds immediate reads and invalidation requires a new load', async () => {
  const cache = swr<number>('snapshot',1000,30000);
  let calls=0;
  cache.seed('account-a',7,Date.now());
  assert.equal(await cache.get('account-a',async()=>++calls),7);
  assert.equal(calls,0);
  cache.seed('account-a',99,Date.now());
  assert.equal(await cache.get('account-a',async()=>++calls),7);
  cache.invalidate('account-a');
  assert.equal(await cache.get('account-a',async()=>++calls),1);
});

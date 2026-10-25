import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

test("Account endpoint caches snapshot and serves repeat query in low milliseconds", async () => {
  const headers = { "X-MS-Internal-Key": INTERNAL_KEY };

  const t0 = Date.now();
  const res1 = await fetch(`${API_URL}/account/DEV`, { headers });
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  const dur1 = Date.now() - t0;

  const t1 = Date.now();
  const res2 = await fetch(`${API_URL}/account/DEV`, { headers });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  const dur2 = Date.now() - t1;

  assert.equal(data1.account, data2.account);
  assert.equal(data1.address, data2.address);
  assert.equal(data1.balances.usdc, data2.balances.usdc);
  // Cached duration should be significantly faster than initial cold query
  assert.ok(dur2 < 50, `Expected cached query < 50ms, got ${dur2}ms`);
});

test("Vault overview SWR cache returns immediately on subsequent calls", async () => {
  const res1 = await fetch(`${API_URL}/vault`);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();

  const t0 = Date.now();
  const res2 = await fetch(`${API_URL}/vault`);
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  const dur = Date.now() - t0;

  assert.equal(data1.network, data2.network);
  assert.equal(data1.investing.round, data2.investing.round);
  assert.equal(data1.investing.vaultId, data2.investing.vaultId);
  assert.ok(dur < 250, `Expected cached vault query < 250ms, got ${dur}ms`);
});

test("Concurrent misses to /gpus catalog safely deduplicate without corruption", async () => {
  const calls = Array.from({ length: 6 }, () =>
    fetch(`${API_URL}/gpus`).then(async (r) => {
      assert.equal(r.status, 200);
      return r.json();
    })
  );

  const results = await Promise.all(calls);
  assert.equal(results.length, 6);

  for (const list of results) {
    assert.equal(list.length, 8);
    const ids = list.map((g: any) => g.id);
    assert.ok(ids.includes("gpu-a"));
    assert.ok(ids.includes("gpu-b"));
    assert.ok(ids.includes("gpu-c"));
    assert.ok(ids.includes("gpu-d"));
    assert.ok(ids.includes("gpu-e"));
    assert.ok(ids.includes("gpu-f"));
    assert.ok(ids.includes("gpu-g"));
    assert.ok(ids.includes("gpu-h"));
  }
});

test("Credit profile caches responses and provides consistent score data", async () => {
  const url = `${API_URL}/credit/devnet/rDBNrgqBmMV3ebnFWhnyxZkdUQb7GZkejc`;
  const res1 = await fetch(url);
  assert.equal(res1.status, 200);
  const p1 = await res1.json();

  const t0 = Date.now();
  const res2 = await fetch(url);
  assert.equal(res2.status, 200);
  const p2 = await res2.json();
  const dur = Date.now() - t0;

  assert.equal(p1.score, p2.score);
  assert.equal(p1.grade, p2.grade);
  assert.equal(p1.address, p2.address);
  assert.ok(dur < 60, `Expected cached profile query < 60ms, got ${dur}ms`);
});

test("SSE event stream explicitly enforces no-cache headers", async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${API_URL}/events`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    const cacheControl = res.headers.get("cache-control");
    assert.ok(cacheControl?.includes("no-cache"));
    controller.abort();
  } catch (err: any) {
    if (err.name !== "AbortError") throw err;
  }
});

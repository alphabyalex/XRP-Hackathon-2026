import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

test("API health endpoint returns ok", async () => {
  const res = await fetch(`${API_URL}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("Vault overview returns live XRPL devnet XLS-65 data", async () => {
  const res = await fetch(`${API_URL}/vault`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.network, "devnet");
  assert.equal(data.simulated, false);
  assert.ok(data.investing);
  assert.equal(data.investing.phase, "investment");
  assert.ok(data.investing.vaultId);
  assert.ok(data.subscribing);
  assert.equal(data.subscribing.phase, "subscription");
});

test("GPU nodes cataloged with multi-provider attributes and live state", async () => {
  const res = await fetch(`${API_URL}/gpus`);
  assert.equal(res.status, 200);
  const gpus = await res.json();
  assert.ok(gpus.length >= 2);

  const ids = gpus.map((g: any) => g.id);
  for (const expectedId of ["gpu-a", "gpu-b"]) {
    assert.ok(ids.includes(expectedId), `Missing ${expectedId}`);
  }

  for (const gpu of gpus) {
    assert.equal(gpu.state, "READY");
    assert.equal(gpu.simulated, false);
    assert.ok(gpu.monteCarlo);
  }
});

test("Risk book stats endpoint returns credit tiers A through E", async () => {
  const res = await fetch(`${API_URL}/risk/book-stats`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.grades));
  assert.equal(data.grades.length, 5);
  const grades = data.grades.map((g: any) => g.grade);
  assert.deepEqual(grades.sort(), ["A", "B", "C", "D", "E"]);
});

test("Credit profile resolves live devnet address with credit score", async () => {
  const res = await fetch(`${API_URL}/credit/devnet/rDBNrgqBmMV3ebnFWhnyxZkdUQb7GZkejc`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.address, "rDBNrgqBmMV3ebnFWhnyxZkdUQb7GZkejc");
  assert.ok(typeof data.score === "number");
  assert.ok(data.grade);
});

test("Account DEV query with internal key returns balances and holdings", async () => {
  const res = await fetch(`${API_URL}/account/DEV`, {
    headers: { "X-MS-Internal-Key": INTERNAL_KEY },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.account, "DEV");
  assert.equal(data.address, "rDBNrgqBmMV3ebnFWhnyxZkdUQb7GZkejc");
  assert.ok(data.balances);
  assert.ok(data.holdings);
});

test("Loan quote connects credit, risk, and pricing services live", async () => {
  const res = await fetch(`${API_URL}/loans/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MS-Internal-Key": INTERNAL_KEY,
    },
    body: JSON.stringify({
      borrower: "DEV",
      gpuId: "gpu-a",
      collateralShares: "100",
      principal: "100",
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.quoteId);
  assert.equal(data.borrower, "DEV");
  assert.ok(data.quote);
  assert.ok(data.terms);
  assert.ok(data.sources);
  assert.equal(data.sources.risk, "live");
  assert.equal(data.sources.credit, "live");
});

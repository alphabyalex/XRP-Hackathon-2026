import test from "node:test";
import assert from "node:assert/strict";
import { isLedgerHash, ledgerBalanceObservation, realLoanOrigin, sampleObservations, transactionVerifier } from "../src/lending/verifiedHistory.js";

const hash = "A".repeat(64);
test("legacy placeholder and unverified-origin records cannot enter real lending history", () => {
  assert.equal(realLoanOrigin({ id: "MOCK_A_DEV", simulated: false, txs: { loanSet: hash } }), null);
  assert.equal(realLoanOrigin({ id: "old", simulated: true, txs: { loanSet: hash } }), null);
  assert.equal(realLoanOrigin({ id: "old", simulated: false, txs: { loanSet: "MOCK_HASH" } }), null);
  assert.equal(realLoanOrigin({ id: "old", simulated: false, txs: "bad-json" }), null);
  assert.equal(realLoanOrigin({ id: "old-real-loan", simulated: false, txs: JSON.stringify({ loanSet: hash }) }), hash);
  assert.equal(isLedgerHash(hash), true);
});

test("origination verification deduplicates actual reads and retries after transport failures", async () => {
  let calls = 0;
  const verify = transactionVerifier(async () => { calls++; if (calls === 1) throw new Error("network unavailable"); return true; });
  assert.equal(await verify(hash), false);
  assert.deepEqual(await Promise.all([verify(hash), verify(hash)]), [true, true]);
  assert.equal(await verify(hash), true);
  assert.equal(calls, 2);
  assert.equal(await verify("MOCK"), false);
  assert.equal(calls, 2);
});

test("chart downsampling retains real observations and the exact headline's latest value", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({ at: index, outstanding: String(index % 37) }));
  const sampled = sampleObservations(rows, 100);
  assert.equal(sampled.length, 100);
  assert.equal(sampled[0], rows[0]);
  assert.equal(sampled.at(-1), rows.at(-1));
  assert(sampled.every(row => rows.includes(row)), "No reconstructed or interpolated balances enter history");
});

test("headline and observation derive from the same real ledger balances, not reconstructed loan sums", () => {
  const snapshot = { simulated: false, investing: { debtTotal: "17.25", assetsTotal: "100", assetsAvailable: "82.75", coverAvailable: "5" } };
  assert.deepEqual(ledgerBalanceObservation(snapshot), { outstanding: 17.25, assets: 100, available: 82.75, cover: 5, utilization: 17.25 });
  assert.equal(ledgerBalanceObservation({ ...snapshot, simulated: true }), null);
  assert.equal(ledgerBalanceObservation({ ...snapshot, investing: { ...snapshot.investing, debtTotal: "" } }), null);
  assert.equal(ledgerBalanceObservation({ simulated: false, investing: null }), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildReturns } from "../src/marketData/returns.js";
import { normalizeCatalog, positivePrice, validCatalog } from "../src/marketData/normalize.js";
import { fetchPriceSource } from "../src/marketData/source.js";

test("returns use received cash, zero-fill UTC dates, and separate GPUs", () => {
  const result = buildReturns("ALICE", 7, [
    { gpuId: "gpu-a", amount: "1.000001", time: "2026-10-18T00:00:00.000Z" },
    { gpuId: "gpu-a", amount: "0.250000", time: "2026-10-20T16:00:00.000Z" },
    { gpuId: "gpu-b", amount: "2.500000", time: "2026-10-24T01:00:00.000Z" },
    { gpuId: "gpu-a", amount: "99", time: "2026-10-17T23:59:59.999Z" },
    { gpuId: "gpu-b", amount: "99", time: "2026-10-25T00:00:00.000Z" },
  ], new Date("2026-10-24T18:00:00.000Z"));
  assert.equal(result.totalEarned, "3.750001");
  assert.equal(result.series[0].days.length, 7);
  assert.equal(result.series[0].days[1].earned, "0.000000");
  assert.equal(result.series[0].days[2].cumulative, "1.250001");
  assert.equal(result.series[1].totalEarned, "2.500000");
  assert.equal(result.series.some(s => /simulated/i.test(s.hardware)), false);
});

test("empty returns are zero, including the leap-day boundary", () => {
  const result = buildReturns("ALICE", 7, [], new Date("2024-03-02T00:00:00.000Z"));
  assert.equal(result.series[0].days[4].date, "2024-02-29");
  assert.equal(result.totalEarned, "0.000000");
});

test("prices with missing or invalid data never become zero-dollar offers", () => {
  for (const value of [null, undefined, "", "0.5", 0, -1, NaN, Infinity]) assert.equal(positivePrice(value), null);
  assert.equal(positivePrice(0.55), "0.550000");
  assert.equal(validCatalog({ gpus: [] }), false);
});

test("market history excludes reconstructed data and preserves model identity", () => {
  const catalog = { gpus: [{ id: "t4", name: "NVIDIA T4", rate_card_median_usd_per_gpu_hour: 0.55, retail_median_new_usd: 999, retail_sellers: 2, rate_cards: 4 }] };
  const history = { models: [{ gpu_id: "t4", series: [
    { source: "skypilot-catalog", weeks: [{ week_start: "2026-10-05", median_usd_per_gpu_hour: 99 }] },
    { source: "gpueconomy", weeks: [{ week_start: "2026-10-19", median_usd_per_gpu_hour: 0.6, providers: 4 }] },
  ] }] };
  const [gpu] = normalizeCatalog(catalog, history, Date.parse("2026-10-24T18:00:00Z"));
  assert.equal(gpu.rentalUsdPerHour, "0.550000");
  assert.deepEqual(gpu.weeklyHistory, [{ date: "2026-10-19", price: "0.600000", providers: 4 }]);
  assert.equal(gpu.sourceUrl, "https://gpueconomy.com/gpu/t4");
});

test("conditional source requests preserve an unchanged snapshot on 304", async () => {
  let conditional: string | undefined;
  const fetcher: typeof fetch = async (_url, options) => {
    conditional = (options?.headers as Record<string, string>)["If-None-Match"];
    return new Response(null, { status: 304 });
  };
  assert.equal(await fetchPriceSource("gpus", '"snapshot-1"', fetcher), null);
  assert.equal(conditional, '"snapshot-1"');
});

test("a failed or malformed feed is rejected before replacing cached data", async () => {
  await assert.rejects(fetchPriceSource("gpus", null, async () => new Response("down", { status: 503 })));
  await assert.rejects(fetchPriceSource("gpus", null, async () => Response.json({ gpus: [] })));
  const result = await fetchPriceSource("gpus", null, async () => Response.json({ data_updated_at: "2026-10-24T12:00:00Z", gpus: [{ id: "t4", name: "T4" }] }, { headers: { ETag: '"latest"' } }));
  assert.equal(result?.etag, '"latest"');
});

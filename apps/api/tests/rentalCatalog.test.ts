import test from "node:test";
import assert from "node:assert/strict";
import { liveAwsRates, nodeAvailability, observedChange24h } from "../src/marketData/rentalData.js";
import { modelObservationStart, modelsForGpu, observedOutputThroughput } from "../src/marketData/modelCatalog.js";
import type { RentalGpu } from "../src/marketData/rentalCatalog.js";

const now = Date.parse("2026-10-25T09:00:00Z");
const offer = { provider: "aws", priceSource: "live", gpuModel: "T4", gpuCount: 1,
  capacityType: "spot", pricePerHourUsd: 0.2, asOf: "2026-10-25T08:55:00Z", region: "us-east-2", instanceType: "g4dn.xlarge" };

test("AWS comparisons reject fixtures, stale reads, wrong GPUs and invalid prices", () => {
  const result = liveAwsRates([offer,
    { ...offer, priceSource: "fixture", pricePerHourUsd: 0.01 },
    { ...offer, asOf: "2026-10-24T00:00:00Z" },
    { ...offer, gpuModel: "A100" },
    { ...offer, pricePerHourUsd: Infinity },
    { ...offer, pricePerHourUsd: -1 },
    { ...offer, gpuCount: 0 },
  ], now);
  assert.equal(result.spot.length, 1);
  assert.equal(result.spot[0].usdPerHour, "0.200000");
  assert.equal(result.spot[0].updatedAt, offer.asOf);
  assert.equal(result.onDemand.length, 0);
});

test("a multi-GPU AWS comparison uses the per-card rate and preserves source time", () => {
  const result = liveAwsRates([{ ...offer, gpuCount: 2, capacityType: "on-demand", pricePerHourUsd: 0.8 }], now);
  assert.equal(result.onDemand[0].usdPerHour, "0.400000");
  assert.match(result.onDemand[0].source, /Price List/);
});

test("physical node counts never multiply router concurrency and offline fleet data is unknown", () => {
  const fleet = [
    { id: "a1", endpoint: true, computeGpuId: "gpu-a", state: { activeJobs: 2, available: true } },
    { id: "a2", endpoint: true, computeGpuId: "gpu-a", state: { activeJobs: 0, available: true } },
    { id: "b", endpoint: false, computeGpuId: "gpu-b", state: { activeJobs: 0, available: true } },
  ];
  assert.deepEqual(nodeAvailability("gpu-a", fleet, offer.asOf), { total: 1, free: 0, busy: 1, reserved: 0, updatedAt: offer.asOf });
  assert.equal(nodeAvailability("gpu-b", fleet, offer.asOf).free, null);
  assert.equal(nodeAvailability("gpu-a", null, null).busy, null);
  assert.equal(nodeAvailability("gpu-a", [{ id: "gpu-a", endpoint: true, state: { activeJobs: 0, available: false, reason: "OFFLINE" } }], offer.asOf).reserved, null);
  const reserved = nodeAvailability("gpu-a", [{ id: "gpu-a", endpoint: true, state: { activeJobs: 0, available: true,
    bookedWindows: [{ start: "2026-10-25T08:00:00Z", end: "2026-10-25T10:00:00Z" }] } }], offer.asOf);
  assert.equal(reserved.reserved, 1);
  assert.equal(reserved.free, 0);
});

test("24-hour change requires an actual observation near the comparison time", () => {
  assert.equal(observedChange24h([], "0.5", now), null);
  assert.equal(observedChange24h([{ time: "2026-10-25T08:00:00Z", rentalUsdPerHour: "0.5" }], "0.6", now), null);
  assert.equal(observedChange24h([{ time: "2026-10-24T08:30:00Z", rentalUsdPerHour: "0.5" }], "0.6", now), "20.00");
});

test("undeployed fitting models cannot accept requests or receive fabricated token prices", () => {
  const gpu = { id: "gpu-a", vramGb: 16, status: "serving", prices: { rentalUsdPerHour: "0.5" }, updatedAt: offer.asOf } as RentalGpu;
  const models = modelsForGpu(gpu);
  assert.equal(models.filter(m => m.status === "serving").length, 1);
  assert.equal(models[0].name, "Qwen2.5-1.5B-Instruct");
  assert.equal(models[0].modelId, "Qwen/Qwen2.5-1.5B-Instruct");
  assert.equal(models[0].pricePer1MTokens, null);
  for (const m of models.filter(m => m.status === "on_request")) {
    assert.equal(m.acceptsRequests, false);
    assert.equal(m.endpoint, null);
    assert.equal(m.pricePer1MTokens, null);
  }
  const measured = modelsForGpu(gpu, 25);
  assert.equal(measured[0].pricePer1MTokens, "5.555556");
  assert.equal(modelsForGpu({ ...gpu, vramGb: 4 }).length, 1);
});

test("historical rows from builds without reliable provenance cannot price current model tokens", () => {
  const boot = Date.now() - 60_000;
  const old = { output_tokens: 1000, started_at: new Date(boot - 2000).toISOString(), finished_at: new Date(boot - 1000).toISOString() };
  const fresh = { output_tokens: 20, started_at: new Date(boot + 1000).toISOString(), finished_at: new Date(boot + 3000).toISOString() };
  assert.equal(observedOutputThroughput([old], boot), null);
  assert.equal(observedOutputThroughput([old, fresh], boot), 10);
});

test("distinct deployed models are serving only on their verified GPU", () => {
  const gpu = { id: "gpu-b", vramGb: 32, status: "serving", modelId: "Qwen/Qwen2.5-3B-Instruct", prices: { rentalUsdPerHour: "0.2" }, updatedAt: offer.asOf } as RentalGpu;
  const models = modelsForGpu(gpu);
  assert.deepEqual(models.filter(m => m.acceptsRequests).map(m => m.modelId), ["Qwen/Qwen2.5-3B-Instruct"]);
});

test("health hides duplicate endpoint aliases and preserves a genuine distinct GPU-B", async () => {
  const { refreshHealth, gpuHealth } = await import("../src/gpuHealth.js");
  const originalFetch = globalThis.fetch;
  const originalA = process.env.GPU_A_VLLM_URL, originalB = process.env.GPU_B_VLLM_URL;
  const originalModelB = process.env.GPU_B_MODEL_ID;
  process.env.GPU_B_MODEL_ID = "Qwen/Qwen2.5-3B-Instruct";
  process.env.GPU_A_VLLM_URL = "http://first/v1/";
  process.env.GPU_B_VLLM_URL = "http://first/";
  globalThis.fetch = async (url) => Response.json({ data: [{ id: "wire-name", root: String(url).includes("second") ? "Qwen/Qwen2.5-3B-Instruct" : "Qwen/Qwen2.5-1.5B-Instruct" }] });
  try {
    await refreshHealth();
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-a")?.ok, true);
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-b")?.error, "duplicate_endpoint");
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-b")?.ok, false);
    process.env.GPU_B_VLLM_URL = "http://second/";
    await refreshHealth();
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-b")?.ok, true);
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-b")?.model, "Qwen/Qwen2.5-3B-Instruct");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalA === undefined) delete process.env.GPU_A_VLLM_URL; else process.env.GPU_A_VLLM_URL = originalA;
    if (originalB === undefined) delete process.env.GPU_B_VLLM_URL; else process.env.GPU_B_VLLM_URL = originalB;
    if (originalModelB === undefined) delete process.env.GPU_B_MODEL_ID; else process.env.GPU_B_MODEL_ID = originalModelB;
  }
});

test("all eight physical IDs require their own matching canonical serving model", async () => {
  const { refreshHealth, gpuHealth } = await import("../src/gpuHealth.js");
  const originalFetch = globalThis.fetch;
  const previous = new Map<string, string | undefined>([["GPU_NODES", process.env.GPU_NODES]]);
  process.env.GPU_NODES = "gpu-a,gpu-b,gpu-c,gpu-d,gpu-e,gpu-f,gpu-g,gpu-h";
  for (const letter of "ABCDEFGH") {
    for (const suffix of ["VLLM_URL", "MODEL_ID"]) {
      const key = `GPU_${letter}_${suffix}`;
      previous.set(key, process.env[key]);
      process.env[key] = suffix === "VLLM_URL" ? `http://verified-${letter.toLowerCase()}` : "Qwen/Qwen2.5-3B-Instruct";
    }
  }
  globalThis.fetch = async url => Response.json({ data: [{ id: "Qwen/Qwen2.5-3B-Instruct",
    root: String(url).includes("verified-h") ? "other-model" : "Qwen/Qwen2.5-3B-Instruct" }] });
  try {
    await refreshHealth();
    assert.deepEqual(gpuHealth().filter(g => g.ok).map(g => g.gpuId), [..."abcdefg"].map(l => `gpu-${l}`));
    assert.equal(gpuHealth().find(g => g.gpuId === "gpu-h")?.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("Qwen3.5-4B is available only on a verified deployed endpoint with adequate memory", () => {
  const gpu = { id: "gpu-e", vramGb: 24, status: "serving", modelId: "Qwen/Qwen2.5-3B-Instruct", prices: { rentalUsdPerHour: "0.25" }, updatedAt: offer.asOf } as RentalGpu;
  const requested = modelsForGpu(gpu).find(model => model.id === "Qwen/Qwen3.5-4B")!;
  assert.equal(requested.status, "on_request");
  assert.equal(requested.acceptsRequests, false);
  assert.equal(requested.endpoint, null);
  const deployed = modelsForGpu({ ...gpu, modelId: requested.id }).find(model => model.id === requested.id)!;
  assert.equal(deployed.status, "serving");
  assert.equal(deployed.contextLength, 4096);
  assert.equal(deployed.publishedContextLength, 262144);
  assert.equal(deployed.pricePer1MTokens, null);
  assert.equal(modelsForGpu({ ...gpu, vramGb: 8 }).some(model => model.id === requested.id), false);
});

test("a model upgrade cannot use an older model's token throughput to advertise a price", () => {
  const base = Date.parse("2026-10-25T10:00:00Z");
  const env = { GPU_E_PLANNING_MODEL_ID: "Qwen/Qwen2.5-3B-Instruct", GPU_E_PLANNING_OBSERVED_AT: "2026-10-25T14:00:00Z" };
  assert.equal(modelObservationStart("gpu-e", "Qwen/Qwen3.5-4B", base, env), null);
  assert.equal(modelObservationStart("gpu-e", "Qwen/Qwen3.5-4B", base, { ...env, GPU_E_PLANNING_MODEL_ID: "Qwen/Qwen3.5-4B" }), Date.parse(env.GPU_E_PLANNING_OBSERVED_AT));
});

test("an endpoint outside the enabled compute registry is never advertised as runnable", async () => {
  const { refreshHealth, gpuHealth } = await import("../src/gpuHealth.js");
  const original = {fetch:globalThis.fetch,nodes:process.env.GPU_NODES,url:process.env.GPU_C_VLLM_URL,model:process.env.GPU_C_MODEL_ID};
  process.env.GPU_NODES = "gpu-a,gpu-b";
  process.env.GPU_C_VLLM_URL = "http://disabled-c";
  process.env.GPU_C_MODEL_ID = "Qwen/Qwen2.5-3B-Instruct";
  let queriedDisabled = false;
  globalThis.fetch = async url => { if(String(url).includes("disabled-c")) queriedDisabled=true; return Response.json({data:[{id:"Qwen/Qwen2.5-3B-Instruct"}]}); };
  try {
    await refreshHealth();
    assert.equal(queriedDisabled,false);
    assert.equal(gpuHealth().find(g=>g.gpuId==="gpu-c")?.error,"not_enabled");
    process.env.GPU_NODES = "gpu-a,gpu-b,gpu-c";
    await refreshHealth();
    assert.equal(gpuHealth().find(g=>g.gpuId==="gpu-c")?.ok,true);
  } finally {
    globalThis.fetch=original.fetch;
    for(const [key,value] of Object.entries({GPU_NODES:original.nodes,GPU_C_VLLM_URL:original.url,GPU_C_MODEL_ID:original.model})) if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { canSignGpuTreasury } from "../src/treasuryCapabilities.js";

test("receive-only treasuries never acquire signing capability from a registry entry", () => {
  const keys = ["MOCK_XRPL", "NETWORK", "DEVNET_TREASURY_GPU_C_SEED", "TREASURY_GPU_C_SEED"];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.MOCK_XRPL = "0";
    process.env.NETWORK = "devnet";
    delete process.env.DEVNET_TREASURY_GPU_C_SEED;
    process.env.TREASURY_GPU_C_SEED = "fixture-on-another-network";
    assert.equal(canSignGpuTreasury("gpu-c"), false);
    process.env.DEVNET_TREASURY_GPU_C_SEED = "fixture-not-a-real-seed";
    assert.equal(canSignGpuTreasury("gpu-c"), true);
    assert.equal(canSignGpuTreasury("gpu-z"), false);
  } finally {
    for (const [key, value] of original) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

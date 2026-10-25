import test from "node:test";
import assert from "node:assert/strict";
import { selectServingGpu } from "../src/routes/servingModel.js";
import type { RentalGpu } from "../src/marketData/rentalCatalog.js";

const fleet = [
  { id: "gpu-a", status: "serving", model: "Qwen2.5-1.5B-Instruct", modelId: "Qwen/Qwen2.5-1.5B-Instruct" },
  { id: "gpu-b", status: "serving", model: "Qwen2.5-3B-Instruct", modelId: "Qwen/Qwen2.5-3B-Instruct" },
] as RentalGpu[];

test("model selection pins the GPU that actually serves its weights", () => {
  assert.equal(selectServingGpu(fleet, undefined, "Qwen/Qwen2.5-3B-Instruct")?.id, "gpu-b");
  assert.equal(selectServingGpu(fleet, "gpu-b", "Qwen/Qwen2.5-1.5B-Instruct"), undefined);
  assert.equal(selectServingGpu(fleet, "gpu-a", "Qwen/Qwen2.5-3B-Instruct"), undefined);
  assert.equal(selectServingGpu(fleet, "gpu-c"), undefined);
});

test("legacy alias maps only to the original GPU's actual weights", () => {
  assert.equal(selectServingGpu(fleet, undefined, "Qwen/Qwen3-1.7B")?.id, "gpu-a");
  assert.equal(selectServingGpu(fleet, "gpu-b", "Qwen/Qwen3-1.7B"), undefined);
  assert.equal(selectServingGpu(fleet.slice(1), undefined, "Qwen/Qwen3-1.7B"), undefined);
});

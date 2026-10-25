import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TASK_TOKENS, taskRequest, taskTokenLimit, type TaskDraft } from "../src/lib/taskRequest";
const draft: TaskDraft = { type: "inference", description: "Explain why the sky is blue in two sentences.", gpuId: "gpu-h", modelId: "Qwen/Qwen2.5-1.5B-Instruct", contextLength: 4096 };
test("checkout submits the actual description once on the selected GPU and canonical model", () => {
  const request = taskRequest(draft, DEFAULT_TASK_TOKENS);
  assert.equal(request.gpuId, draft.gpuId); assert.equal(request.modelId, draft.modelId);
  assert.deepEqual(request.requests, [[{ role: "user", content: draft.description }]]);
  assert.equal(request.maxTokens, 512); assert.equal(request.tokens, 512); assert.equal(request.kind, "inference");
  assert.equal(JSON.stringify(request).includes("GPU utilization and revenue"), false);
});
test("unsupported workloads, missing descriptions and unavailable model choices never become orders", () => {
  for (const type of ["fine-tune", "render", "other"] as const) assert.throws(() => taskRequest({ ...draft, type }, 512));
  for (const patch of [{ description: " " }, { gpuId: "" }, { modelId: "" }]) assert.throws(() => taskRequest({ ...draft, ...patch }, 512));
});
test("output size stays within the serving context and never creates an automatic batch", () => {
  assert.throws(() => taskRequest(draft, 5000)); assert.throws(() => taskRequest(draft, 1.5));
  const long = { ...draft, description: "a".repeat(3500) };
  assert.equal(taskTokenLimit(long.description), 340); assert.throws(() => taskRequest(long, 512));
  assert.equal((taskRequest(long, 128).requests as unknown[]).length, 1);
});

import type { OrderRequest, TaskType } from "./routerApi";

export interface TaskDraft { type: TaskType; description: string; gpuId: string; modelId: string; contextLength?: number }
export const DEFAULT_TASK_TOKENS = 512;
export function taskTokenLimit(description: string, contextLength = 4096): number {
  // UTF-8 bytes provide a conservative input budget, with room for the chat template.
  return Math.max(0, Math.min(1024, Math.min(4096, contextLength) - new TextEncoder().encode(description.trim()).length - 256));
}
export function taskRequest(task: TaskDraft, outputTokens: number, deadline = "", now = Date.now()): OrderRequest {
  if (task.type !== "inference") throw new Error("This endpoint supports text inference. See Docs for other workloads.");
  const description = task.description.trim();
  if (!description) throw new Error("Describe the task you want this model to run.");
  if (!/^gpu-[a-h]$/.test(task.gpuId) || !task.modelId) throw new Error("Choose a serving GPU and model.");
  const limit = taskTokenLimit(description, task.contextLength);
  if (limit < 1) throw new Error("Shorten the task description to fit the model context.");
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > limit) throw new Error(`Use between 1 and ${limit} output tokens, or shorten the description.`);
  const left = deadline ? (Date.parse(deadline) - now) / 1000 : 0;
  return { kind: "inference", taskType: "inference", gpuId: task.gpuId, modelId: task.modelId,
    tokens: outputTokens, maxTokens: outputTokens, requests: [[{ role: "user", content: description }]],
    ...(left > 60 ? { deadlineSeconds: Math.round(left) } : {}) };
}

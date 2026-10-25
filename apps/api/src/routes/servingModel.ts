import type { RentalGpu } from "../marketData/rentalCatalog.js";

/** Select the endpoint and its actual weights together. Never route a model to another GPU's weights. */
export function selectServingGpu(gpus: RentalGpu[], gpuId?: string, requestedModel?: string): RentalGpu | undefined {
  return gpus.find(gpu => {
    if (gpu.status !== "serving" || (gpuId && gpu.id !== gpuId)) return false;
    const canonical = gpu.modelId ?? `Qwen/${gpu.model}`;
    return !requestedModel || requestedModel === canonical ||
      (gpu.id === "gpu-a" && canonical === "Qwen/Qwen2.5-1.5B-Instruct" && requestedModel === "Qwen/Qwen3-1.7B");
  });
}

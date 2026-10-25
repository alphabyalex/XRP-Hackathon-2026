import type { RentalGpu } from "./rentalCatalog.js";

const MODEL_SPECS = [
  { id: "Qwen/Qwen2.5-1.5B-Instruct", name: "Qwen2.5-1.5B-Instruct", vramGb: 5, parametersBillion: 1.54 },
  { id: "Qwen/Qwen2.5-0.5B-Instruct", name: "Qwen2.5-0.5B-Instruct", vramGb: 3, parametersBillion: 0.49 },
  { id: "Qwen/Qwen2.5-3B-Instruct", name: "Qwen2.5-3B-Instruct", vramGb: 9, parametersBillion: 3.09 },
] as const;

export function modelsForGpu(gpu: RentalGpu, measuredOutputTokensPerSecond: number | null = null) {
  return MODEL_SPECS.filter(model => model.vramGb <= gpu.vramGb).map(model => {
    const serving = gpu.id === "gpu-a" && model.id === "Qwen/Qwen2.5-1.5B-Instruct" && gpu.status === "serving";
    const price = serving && gpu.prices.rentalUsdPerHour && measuredOutputTokensPerSecond && measuredOutputTokensPerSecond > 0
      ? (Number(gpu.prices.rentalUsdPerHour) * 1_000_000 / (3600 * measuredOutputTokensPerSecond)).toFixed(6) : null;
    return {
      gpuId: gpu.id, id: model.id, modelId: model.id, name: model.name,
      status: serving ? "serving" as const : "on_request" as const,
      acceptsRequests: serving, vramGb: model.vramGb, vramBasis: "FP16 weights plus context and runtime budget",
      parametersBillion: model.parametersBillion,
      // The current deployment caps context at 4096. On-request sizing uses the
      // same budget; this is not a claim about a future endpoint configuration.
      contextLength: 4096, publishedContextLength: 32768,
      sourceUrl: `https://huggingface.co/${model.id}`,
      pricePer1MTokens: price, currency: "USD",
      priceBasis: price ? "Live hourly rate divided by observed output throughput" : null,
      endpoint: serving ? "/v1/chat/completions" : null,
      updatedAt: gpu.updatedAt,
    };
  });
}

import type { RentalGpu } from "./rentalCatalog.js";

const MODEL_SPECS = [
  { id: "Qwen/Qwen2.5-1.5B-Instruct", name: "Qwen2.5-1.5B-Instruct", vramGb: 5, parametersBillion: 1.54, publishedContextLength: 32768 },
  { id: "Qwen/Qwen2.5-0.5B-Instruct", name: "Qwen2.5-0.5B-Instruct", vramGb: 3, parametersBillion: 0.49, publishedContextLength: 32768 },
  { id: "Qwen/Qwen2.5-3B-Instruct", name: "Qwen2.5-3B-Instruct", vramGb: 9, parametersBillion: 3.09, publishedContextLength: 32768 },
  // Published architecture/context: https://huggingface.co/Qwen/Qwen3.5-4B
  // 12 GB is a conservative planning budget, not an observed memory reading.
  { id: "Qwen/Qwen3.5-4B", name: "Qwen3.5-4B", vramGb: 12, parametersBillion: 4, publishedContextLength: 262144 },
] as const;

export interface ThroughputObservation { output_tokens: number; started_at: string; finished_at: string }
export function modelObservationStart(gpuId: string, modelId: string | undefined, fallback: number, env: NodeJS.ProcessEnv = process.env): number | null {
  const prefix = gpuId.toUpperCase().replace(/-/g, "_");
  const measuredModel = env[`${prefix}_PLANNING_MODEL_ID`];
  if (measuredModel && measuredModel !== modelId) return null;
  const dates = [env[`${prefix}_PRICE_UPDATED_AT`], measuredModel ? env[`${prefix}_PLANNING_OBSERVED_AT`] : undefined]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  return Math.max(fallback, ...dates);
}
export function observedOutputThroughput(rows: ThroughputObservation[], notBefore: number): number | null {
  let tokens = 0, seconds = 0;
  for (const row of rows) {
    const start = Date.parse(row.started_at), finish = Date.parse(row.finished_at);
    const elapsed = (finish - start) / 1000;
    if (start >= notBefore && finish <= Date.now() && elapsed > 0 && Number.isFinite(elapsed)
      && Number.isSafeInteger(row.output_tokens) && row.output_tokens > 0) {
      tokens += row.output_tokens; seconds += elapsed;
    }
  }
  return seconds > 0 ? tokens / seconds : null;
}

export function modelsForGpu(gpu: RentalGpu, measuredOutputTokensPerSecond: number | null = null) {
  return MODEL_SPECS.filter(model => model.vramGb <= gpu.vramGb).map(model => {
    const deployed = gpu.modelId ?? (gpu.model ? `Qwen/${gpu.model}` : gpu.id === "gpu-a" ? "Qwen/Qwen2.5-1.5B-Instruct" : null);
    const serving = model.id === deployed && gpu.status === "serving";
    const price = serving && gpu.prices.rentalUsdPerHour && measuredOutputTokensPerSecond && measuredOutputTokensPerSecond > 0
      ? (Number(gpu.prices.rentalUsdPerHour) * 1_000_000 / (3600 * measuredOutputTokensPerSecond)).toFixed(6) : null;
    return {
      gpuId: gpu.id, id: model.id, modelId: model.id, name: model.name,
      status: serving ? "serving" as const : "on_request" as const,
      acceptsRequests: serving, vramGb: model.vramGb, vramBasis: "Estimated budget for 16-bit weights, context and runtime",
      parametersBillion: model.parametersBillion,
      // The current deployment caps context at 4096. On-request sizing uses the
      // same budget; this is not a claim about a future endpoint configuration.
      contextLength: 4096, publishedContextLength: model.publishedContextLength,
      sourceUrl: `https://huggingface.co/${model.id}`,
      pricePer1MTokens: price, currency: "USD",
      priceBasis: price ? "Live hourly rate divided by observed output throughput" : null,
      endpoint: serving ? "/v1/chat/completions" : null,
      updatedAt: gpu.updatedAt,
    };
  });
}

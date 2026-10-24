import { validCatalog, validHistory } from "./normalize.js";

export interface PriceSourceDocument {
  data_updated_at: string;
  [key: string]: unknown;
}

export async function fetchPriceSource(resource: "gpus" | "history", etag: string | null, fetcher: typeof fetch = fetch): Promise<{
  body: PriceSourceDocument; etag: string | null;
} | null> {
  const headers: Record<string, string> = { "User-Agent": "Moonshift/1.0 (GPU price comparison)", Accept: "application/json" };
  if (etag) headers["If-None-Match"] = etag;
  const response = await fetcher(`https://gpueconomy.com/${resource}.json`, { headers, signal: AbortSignal.timeout(10000) });
  if (response.status === 304 && etag) return null;
  if (!response.ok) throw new Error("GPU price source unavailable");
  const raw = await response.json();
  if (!(resource === "gpus" ? validCatalog(raw) : validHistory(raw))) throw new Error("Invalid GPU price response");
  return { body: raw as PriceSourceDocument, etag: response.headers.get("etag") };
}

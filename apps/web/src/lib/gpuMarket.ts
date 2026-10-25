// Share market for one GPU. Numbers come from Kristian's GET /gpus/:id/stats once it answers;
// until then the page uses what GET /gpus/:id already reports, and leaves the rest blank.
import { apiFetch, NotFoundError } from "./api";
import { usePolled } from "./liveData";
import type { TxResult } from "@moonshift/shared";

export interface BookLevel {
  price: string | number;
  qty: string | number;
}
export interface Trade {
  t: string | number; // ISO time or ms
  price: string | number;
  qty: string | number;
  side?: "buy" | "sell";
  hash?: string;
  explorerUrl?: string;
}
export interface GpuStats {
  gpuId: string;
  price?: string | number;
  change24hPct?: string | number | null;
  volume24h?: string | number | null;
  high24h?: string | number | null;
  low24h?: string | number | null;
  marketCap?: string | number | null;
  holders?: number | null;
  navPerShare?: string | number | null;
  yieldPct?: string | number | null;
  paidPerShare24h?: string | number | null;
  bids?: BookLevel[];
  asks?: BookLevel[];
  trades?: Trade[];
  ticks?: { t: string | number; price: string | number; qty?: string | number }[];
  updatedAt?: string;
}

// Off until Kristian's routes are on the merged api (GET /gpus/:id/stats, POST /market/:gpuId/order):
// calling a missing route every 3 s would only log errors. Flip at integration once they answer.
export const STATS_LIVE = false;

export const useGpuStats = (gpuId: string) =>
  usePolled<GpuStats>(STATS_LIVE ? `/gpus/${encodeURIComponent(gpuId)}/stats` : null, { ms: 3000, on: ["market", "stats", "tx"] });

export const toMs = (t: string | number) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : new Date(t).getTime());

// Market order on the share / USDC book. Falls back to the share routes the api has today.
export async function placeOrder(gpuId: string, side: "buy" | "sell", qty: string, price?: string): Promise<TxResult> {
  if (!STATS_LIVE) return apiFetch<TxResult>(side === "buy" ? "/shares/buy" : "/shares/sell", { method: "POST", body: JSON.stringify({ gpuId, qty, price }) });
  try {
    return await apiFetch<TxResult>(`/market/${encodeURIComponent(gpuId)}/order`, { method: "POST", body: JSON.stringify({ side, qty, price }) });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    return apiFetch<TxResult>(side === "buy" ? "/shares/buy" : "/shares/sell", { method: "POST", body: JSON.stringify({ gpuId, qty, price }) });
  }
}

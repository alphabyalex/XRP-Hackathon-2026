// Share market for one GPU. Numbers come from Kristian's GET /gpus/:id/stats once it answers;
// until then the page uses what GET /gpus/:id already reports, and leaves the rest blank.
import { useEffect, useState } from "react";
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
  openPrice?: string | number | null;
  revenue24h?: string | number | null;
  workingPct20h?: string | number | null;
  paidToHoldersLastNight?: string | number | null;
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

// GET /gpus/:id/stats answers: one share price (sharePriceOf in apps/api), 24h change from
// today's opening price, yield and payouts from the dividend ledger. Every page reads it.
export const STATS_LIVE = true;
// POST /market/:gpuId/order is not on the api yet; trades use /shares/buy and /shares/sell.
export const ORDER_ROUTE_LIVE = false;

export const useGpuStats = (gpuId: string) =>
  usePolled<GpuStats>(STATS_LIVE ? `/gpus/${encodeURIComponent(gpuId)}/stats` : null, { ms: 3000, on: ["market", "stats", "tx"] });

// Stats for several GPUs at once (Home, Market): polled together every 5 s.
export function useStatsMap(ids: string[]): Record<string, GpuStats> {
  const key = ids.join(",");
  const [map, setMap] = useState<Record<string, GpuStats>>({});
  useEffect(() => {
    if (!STATS_LIVE || !key) return;
    let alive = true;
    const load = () =>
      Promise.all(
        key.split(",").map((id) =>
          apiFetch<GpuStats>(`/gpus/${encodeURIComponent(id)}/stats`)
            .then((s) => [id, s] as const)
            .catch(() => null)
        )
      ).then((rows) => {
        if (!alive) return;
        const got = rows.filter((r): r is readonly [string, GpuStats] => !!r);
        if (got.length) setMap((m) => ({ ...m, ...Object.fromEntries(got) }));
      });
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return map;
}

const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// The one share price: the stats route's, else what /gpus reports (the same sharePriceOf).
export const priceOf = (s: GpuStats | undefined, fallback: unknown) => numOrNull(s?.price) ?? numOrNull(fallback) ?? 0;
// 24h change from today's opening price; null (shown as "–") when there is no opening price.
export const changeOf = (s: GpuStats | undefined) => (s && numOrNull(s.openPrice) !== null ? numOrNull(s.change24hPct) : null);
export const yieldOf = (s: GpuStats | undefined, fallback: unknown) => numOrNull(s?.yieldPct) ?? numOrNull(fallback);
export const fmtChange = (ch: number | null) => (ch === null ? "–" : `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`);

export const toMs = (t: string | number) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : new Date(t).getTime());

// Market order on the share / USDC book. Falls back to the share routes the api has today.
export async function placeOrder(gpuId: string, side: "buy" | "sell", qty: string, price?: string): Promise<TxResult> {
  if (!ORDER_ROUTE_LIVE) return apiFetch<TxResult>(side === "buy" ? "/shares/buy" : "/shares/sell", { method: "POST", body: JSON.stringify({ gpuId, qty, price }) });
  try {
    return await apiFetch<TxResult>(`/market/${encodeURIComponent(gpuId)}/order`, { method: "POST", body: JSON.stringify({ side, qty, price }) });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    return apiFetch<TxResult>(side === "buy" ? "/shares/buy" : "/shares/sell", { method: "POST", body: JSON.stringify({ gpuId, qty, price }) });
  }
}

import { db } from "../db/db.js";
import { gpuHealth, refreshHealth } from "../gpuHealth.js";
import { internalHeaders } from "../adapters/serviceFetch.js";
import { broadcast } from "../sse.js";
import { getGpuPrices } from "./gpuPrices.js";
import { liveAwsRates, nodeAvailability, observedChange24h, type AwsOffer, type FleetRow, type LiveRate } from "./rentalData.js";

export interface RentalGpu {
  id: string; label: string; provider: string; card: string; vramGb: number;
  vcpu: number; ramGb: number; storageGb: number;
  location: { city: string | null; region: string | null };
  model: string; status: "serving"; updatedAt: string;
  prices: { rentalUsdPerHour: string | null; currency: "USD"; economy: LiveRate | null; awsSpot: LiveRate | null; awsOnDemand: LiveRate | null; change24hPct: string | null };
  nodes: ReturnType<typeof nodeAvailability>;
  utilization24h: { time: string; utilizationPct: number; t: string; pct: number }[];
  utilizationMetric: "observed_worker_busy_pct";
}
export interface RentalCatalog { updatedAt: string; gpus: RentalGpu[] }

db.exec(`CREATE TABLE IF NOT EXISTS rental_utilization_samples (
  gpu_id TEXT NOT NULL, observed_at TEXT NOT NULL, utilization_pct REAL NOT NULL,
  PRIMARY KEY(gpu_id, observed_at)
); CREATE INDEX IF NOT EXISTS rental_utilization_time ON rental_utilization_samples(observed_at);`);

let snapshot: RentalCatalog | null = null;
let pending: Promise<RentalCatalog> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastAws = "";
let awsSnapshot: { updatedAt: string | null; spot: LiveRate[]; onDemand: LiveRate[] } = { updatedAt: null, spot: [], onDemand: [] };

export function cachedRentalCatalog(): RentalCatalog | null {
  if (!snapshot || Date.now() - Date.parse(snapshot.updatedAt) > 15_000) return null;
  // A failed health check hides a cached card immediately.
  const online = new Set(gpuHealth().filter(h => h.kind === "real" && h.ok).map(h => h.gpuId));
  return { ...snapshot, gpus: snapshot.gpus.filter(g => online.has(g.id as any)) };
}
export function cachedRentalGpu(gpuId: string): RentalGpu | undefined { return cachedRentalCatalog()?.gpus.find(g => g.id === gpuId); }
export function cachedAwsPrices() { return awsSnapshot; }

async function routerJson<T>(path: string): Promise<T> {
  const url = (process.env.ROUTER_URL ?? "http://localhost:7200").replace(/\/$/, "");
  const res = await fetch(`${url}${path}`, { headers: internalHeaders(), signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error("Router data unavailable");
  return await res.json() as T;
}

export function refreshRentalCatalog(): Promise<RentalCatalog> {
  if (pending) return pending;
  pending = (async () => {
    if (!gpuHealth().some(h => h.checkedAt)) await refreshHealth();
    const [marketResult, fleetResult, awsResult] = await Promise.allSettled([
      getGpuPrices(), routerJson<FleetRow[]>("/fleet"), routerJson<{ offers?: AwsOffer[] }>("/catalog?provider=aws&gpuModel=T4"),
    ]);
    const now = new Date().toISOString();
    const market = marketResult.status === "fulfilled" ? marketResult.value : null;
    const fleet = fleetResult.status === "fulfilled" && Array.isArray(fleetResult.value) ? fleetResult.value : null;
    const aws = liveAwsRates(awsResult.status === "fulfilled" && Array.isArray(awsResult.value.offers) ? awsResult.value.offers : []);
    awsSnapshot = { updatedAt: [...aws.spot, ...aws.onDemand].map(p => p.updatedAt).sort().at(-1) ?? null, ...aws };
    const fingerprint = JSON.stringify(awsSnapshot);
    if (fingerprint !== lastAws) {
      lastAws = fingerprint;
      // Kristian owns SseEventType; the event is supported by the wire protocol.
      broadcast("aws" as Parameters<typeof broadcast>[0], awsSnapshot);
    }
    const online = gpuHealth().find(h => h.gpuId === "gpu-a" && h.kind === "real" && h.ok && h.checkedAt && Date.now() - Date.parse(h.checkedAt) < 120_000);
    const gpus: RentalGpu[] = [];
    if (online && process.env.GPU_A_VLLM_URL?.trim()) {
      const rate = market?.gpus.find(g => g.id === "t4" || /\bt4\b/i.test(g.name));
      const economy: LiveRate | null = market && !market.stale && rate?.rentalUsdPerHour ? {
        usdPerHour: rate.rentalUsdPerHour, updatedAt: market.sourceUpdatedAt,
        source: "GPU Economy median", sourceUrl: rate.sourceUrl,
      } : null;
      const nodes = nodeAvailability("gpu-a", fleet, fleet ? now : null);
      if (nodes.busy !== null && nodes.reserved === 0) {
        db.prepare("INSERT OR IGNORE INTO rental_utilization_samples (gpu_id,observed_at,utilization_pct) VALUES (?,?,?)")
          .run("gpu-a", now, nodes.busy * 100);
      }
      const samples = (db.prepare("SELECT observed_at AS time, utilization_pct AS utilizationPct FROM rental_utilization_samples WHERE gpu_id=? AND observed_at>=? ORDER BY observed_at")
        .all("gpu-a", new Date(Date.now() - 24 * 3600_000).toISOString()) as { time: string; utilizationPct: number }[])
        .map(sample => ({ ...sample, t: sample.time, pct: sample.utilizationPct }));
      gpus.push({ id: "gpu-a", label: "GPU-A", provider: "Akash Network", card: "NVIDIA T4", vramGb: 16,
        vcpu: 4, ramGb: 16, storageGb: 100,
        // Read-only provider record verified 2026-10-25: city=LIS, country=PT,
        // location-region=eu-southwest. Environment overrides support relocation.
        location: { city: process.env.GPU_A_CITY?.trim() || "Lisbon (LIS)", region: process.env.GPU_A_REGION?.trim() || "eu-southwest, Portugal" },
        model: "Qwen2.5-1.5B-Instruct", status: "serving", updatedAt: online.checkedAt!,
        prices: { rentalUsdPerHour: economy?.usdPerHour ?? null, currency: "USD", economy, awsSpot: aws.spot[0] ?? null,
          awsOnDemand: aws.onDemand[0] ?? null, change24hPct: observedChange24h(rate?.observations ?? [], economy?.usdPerHour ?? null) },
        nodes, utilization24h: samples, utilizationMetric: "observed_worker_busy_pct" });
    }
    db.prepare("DELETE FROM rental_utilization_samples WHERE observed_at<?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
    snapshot = { updatedAt: now, gpus };
    return snapshot;
  })().finally(() => { pending = null; });
  return pending;
}

export async function getRentalCatalog(): Promise<RentalCatalog> {
  const cached = cachedRentalCatalog();
  if (cached) return cached;
  return refreshRentalCatalog();
}
export function startRentalCatalogPolling(): void {
  if (timer) return;
  void refreshRentalCatalog().catch(() => undefined);
  timer = setInterval(() => void refreshRentalCatalog().catch(() => undefined), 5000);
  timer.unref();
}

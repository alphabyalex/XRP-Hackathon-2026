import type { GpuMarketPricesResponse } from "@moonshift/shared";
import { db } from "../db/db.js";
import { normalizeCatalog } from "./normalize.js";
import { fetchPriceSource } from "./source.js";

const requested = Number(process.env.GPU_PRICE_REFRESH_SECONDS ?? 900);
export const GPU_PRICE_REFRESH_SECONDS = Number.isFinite(requested) ? Math.max(900, Math.floor(requested)) : 900;
const REFRESH_MS = GPU_PRICE_REFRESH_SECONDS * 1000;
const SOURCE = "https://gpueconomy.com";
const STALE_MS = 48 * 3600000;

// Independent market-data tables: app resets must not erase observed prices.
db.exec(`
  CREATE TABLE IF NOT EXISTS gpu_market_cache (
    resource TEXT PRIMARY KEY, body TEXT NOT NULL, etag TEXT,
    checked_at TEXT NOT NULL, fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gpu_market_observations (
    model_id TEXT NOT NULL, observed_at TEXT NOT NULL,
    rental_price TEXT,
    PRIMARY KEY(model_id, observed_at)
  );
  CREATE INDEX IF NOT EXISTS gpu_market_observed_at ON gpu_market_observations(observed_at);
`);

interface CachedResource { resource: string; body: string; etag: string | null; checked_at: string; fetched_at: string }
const cached = (resource: string) => db.prepare("SELECT * FROM gpu_market_cache WHERE resource=?").get(resource) as CachedResource | undefined;
let inFlight: Promise<void> | null = null;
let lastAttempt = 0;

async function refreshResource(resource: "gpus" | "history") {
  const previous = cached(resource);
  const response = await fetchPriceSource(resource, previous?.etag ?? null);
  const checkedAt = new Date().toISOString();
  if (!response && previous) {
    db.prepare("UPDATE gpu_market_cache SET checked_at=? WHERE resource=?").run(checkedAt, resource);
    return;
  }
  if (!response) return;
  const raw = response.body;
  db.prepare(`INSERT OR REPLACE INTO gpu_market_cache (resource,body,etag,checked_at,fetched_at) VALUES (?,?,?,?,?)`)
    .run(resource, JSON.stringify(raw), response.etag, checkedAt, checkedAt);
  if (resource === "gpus") {
    const insert = db.prepare("INSERT OR IGNORE INTO gpu_market_observations (model_id,observed_at,rental_price) VALUES (?,?,?)");
    // Only published timestamps become observations. Polls do not manufacture
    // new history when the publisher returns the same underlying snapshot.
    for (const gpu of normalizeCatalog(raw, null)) {
      insert.run(gpu.id, new Date(raw.data_updated_at).toISOString(), gpu.rentalUsdPerHour);
    }
    db.prepare("DELETE FROM gpu_market_observations WHERE observed_at < ?")
      .run(new Date(Date.now() - 366 * 86400000).toISOString());
  }
}

export function refreshGpuPrices(): Promise<void> {
  if (inFlight) return inFlight;
  const catalog = cached("gpus");
  const history = cached("history");
  const due = (value: CachedResource | undefined) => !value || Date.now() - Date.parse(value.checked_at) >= REFRESH_MS;
  if (Date.now() - lastAttempt < REFRESH_MS || (!due(catalog) && !due(history))) return Promise.resolve();
  lastAttempt = Date.now();
  inFlight = Promise.allSettled([
    ...(due(catalog) ? [refreshResource("gpus")] : []),
    ...(due(history) ? [refreshResource("history")] : []),
  ]).then(() => undefined).finally(() => { inFlight = null; });
  return inFlight;
}

export function startGpuPricePolling(): void {
  void refreshGpuPrices();
  setInterval(() => void refreshGpuPrices(), REFRESH_MS).unref();
}

export async function getGpuPrices(): Promise<GpuMarketPricesResponse | null> {
  // Persisted reads return immediately; the first ever read waits for the feed.
  if (cached("gpus")) void refreshGpuPrices();
  else await refreshGpuPrices();
  const catalog = cached("gpus");
  if (!catalog) return null;
  const raw = JSON.parse(catalog.body);
  const history = cached("history");
  const historyRaw = history ? JSON.parse(history.body) : null;
  const observations = db.prepare("SELECT * FROM gpu_market_observations WHERE observed_at >= ? ORDER BY observed_at")
    .all(new Date(Date.now() - 7 * 86400000).toISOString()) as {
    model_id: string; observed_at: string; rental_price: string | null;
  }[];
  const byModel = new Map<string, typeof observations>();
  for (const observation of observations) {
    const group = byModel.get(observation.model_id) ?? [];
    group.push(observation); byModel.set(observation.model_id, group);
  }
  return {
    source: { name: "GPU Economy", url: `${SOURCE}/data`, license: "CC BY 4.0" },
    sourceUpdatedAt: new Date(raw.data_updated_at).toISOString(), checkedAt: catalog.checked_at,
    refreshSeconds: GPU_PRICE_REFRESH_SECONDS,
    stale: Date.now() - Date.parse(raw.data_updated_at) > STALE_MS || Date.now() - Date.parse(catalog.checked_at) > REFRESH_MS * 2,
    historyStale: !history || Date.now() - Date.parse(historyRaw.data_updated_at) > STALE_MS,
    gpus: normalizeCatalog(raw, historyRaw).map(gpu => ({ ...gpu, observations: (byModel.get(gpu.id) ?? []).map(row => ({
      time: row.observed_at, rentalUsdPerHour: row.rental_price,
    })) })),
  };
}

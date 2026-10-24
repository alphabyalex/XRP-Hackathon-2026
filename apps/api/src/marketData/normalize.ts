import { fix6, type GpuMarketPrice } from "@moonshift/shared";

export function positivePrice(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? fix6(value) : null;
}

export function validCatalog(raw: any): boolean {
  return typeof raw?.data_updated_at === "string" && Number.isFinite(Date.parse(raw.data_updated_at)) &&
    Array.isArray(raw.gpus) && raw.gpus.some((g: any) => typeof g.id === "string" && typeof g.name === "string");
}

export function validHistory(raw: any): boolean {
  return typeof raw?.data_updated_at === "string" && Number.isFinite(Date.parse(raw.data_updated_at)) && Array.isArray(raw.models);
}

export function normalizeCatalog(catalog: any, history: any, now = Date.now()): GpuMarketPrice[] {
  const oldest = new Date(now - 366 * 86400000).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  return catalog.gpus.filter((gpu: any) => /^[a-z0-9-]+$/.test(gpu.id) && typeof gpu.name === "string").map((gpu: any) => {
    const model = history?.models?.find((m: any) => m.gpu_id === gpu.id);
    // Never mix reconstructed catalogue history with the publisher's own reads.
    const weeks = model?.series?.find((s: any) => s.source === "gpueconomy")?.weeks ?? [];
    const unique = new Map<string, { date: string; price: string; providers: number }>();
    for (const week of weeks) {
      const price = positivePrice(week.median_usd_per_gpu_hour);
      if (price && /^\d{4}-\d{2}-\d{2}$/.test(week.week_start) && week.week_start >= oldest && week.week_start <= today) {
        unique.set(week.week_start, { date: week.week_start, price, providers: Number(week.providers) || 0 });
      }
    }
    return {
      id: gpu.id, name: gpu.name, vramGb: Number(gpu.vram_gb) || 0,
      rentalUsdPerHour: positivePrice(gpu.rate_card_median_usd_per_gpu_hour),
      providers: Number(gpu.rate_cards) || 0,
      sourceUrl: `https://gpueconomy.com/gpu/${gpu.id}`,
      weeklyHistory: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)),
      observations: [],
    };
  }).sort((a: GpuMarketPrice, b: GpuMarketPrice) => a.name.localeCompare(b.name));
}

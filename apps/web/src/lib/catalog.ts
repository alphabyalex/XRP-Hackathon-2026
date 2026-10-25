// Shapes for Tharun's compute catalog routes (contracts/compute/*.json). Every price or count can
// be null when the live source has nothing fresh; the UI shows a dash, never a made-up number.
import { usePolled } from "./liveData";

export interface PricePoint {
  usdPerHour: string | number | null;
  updatedAt?: string | null;
  source?: string;
  sourceUrl?: string;
  region?: string;
  instanceType?: string;
}

export interface CatalogGpu {
  id: string;
  label: string;
  provider: string;
  card: string;
  vramGb: number | null;
  vcpu: number | null;
  ramGb: number | null;
  storageGb: number | null;
  location: { city: string | null; region: string | null };
  model: string | null;
  status: string;
  updatedAt: string;
  prices: {
    rentalUsdPerHour: string | number | null;
    currency: string;
    economy: PricePoint | null;
    awsSpot: PricePoint | null;
    awsOnDemand: PricePoint | null;
    change24hPct: string | number | null;
  };
  nodes: { total: number | null; free: number | null; busy: number | null; reserved: number | null; updatedAt: string | null };
  utilization24h: ({ t: string; pct: number } | number)[];
  utilizationMetric?: string;
}

export interface Catalog {
  updatedAt: string | null;
  gpus: CatalogGpu[];
}

export interface CatalogModel {
  gpuId: string;
  id: string;
  modelId: string;
  name: string;
  status: string;
  acceptsRequests: boolean;
  vramGb: number | null;
  parametersBillion: number | null;
  contextLength: number | null;
  pricePer1MTokens: string | number | null;
  endpoint: string | null;
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const usdHr = (v: unknown, digits = 3) => {
  const n = num(v);
  return n === null ? "–" : `$${n.toFixed(digits)}`;
};

// "Frankfurt, eu-central" or the provider when the lease has no verified location yet.
export function whereOf(g: CatalogGpu): string {
  const parts = [g.location?.city, g.location?.region].filter(Boolean);
  return parts.length ? parts.join(", ") : g.provider;
}

// Utilization samples as chart points; accepts plain numbers or {t, pct}.
export function utilPoints(g: CatalogGpu): number[] {
  return (g.utilization24h ?? []).map((u) => (typeof u === "number" ? u : Number(u.pct))).filter((v) => Number.isFinite(v));
}

export const useCatalog = () => usePolled<Catalog>("/catalog/gpus", { ms: 5000, on: ["calendar", "usage", "aws"] });
export const useModels = (gpuId: string) => usePolled<{ models: CatalogModel[] }>(`/models?gpuId=${encodeURIComponent(gpuId)}`, { ms: 15000 });

// GET /gpus/:id/calendar?days=7 (contracts/compute/calendar.json): one block per hour.
export interface CalendarBlock {
  start: string;
  end: string;
  bookedMinutes: number;
  runningMinutes: number;
  status: string; // free | booked | running | ...
  refs: string[];
}
export interface GpuCalendar {
  gpuId: string;
  from: string;
  to: string;
  updatedAt: string;
  blocks: CalendarBlock[];
}
export const useGpuCalendar = (gpuId: string, days = 7) =>
  usePolled<GpuCalendar>(`/gpus/${encodeURIComponent(gpuId)}/calendar?days=${days}`, { ms: 5000, on: ["calendar", "usage"] });

// POST /tasks/estimate and POST /tasks/quote (contracts/compute/tasks_*.json).
export interface Sizing {
  gpus: number;
  vcpu: number;
  ramGb: number;
  storageGb: number;
  durationSeconds: number;
  model: string | null;
}
export interface TaskEstimate {
  source: string;
  modelId: string | null;
  sizing: Sizing;
  suggestedGpus: string[];
  availability: string;
}
export interface TaskQuoteOption {
  mode: string;
  gpuId: string;
  pricePerHour: string;
  totalPrice: string;
  estimatedDurationSeconds: number;
  priceCap: string;
  updatedAt: string;
}
export interface TaskQuote extends Omit<TaskQuoteOption, "gpuId"> {
  currency: string;
  options: TaskQuoteOption[];
}
export interface Booking {
  bookingId: string;
  slotStart: string;
  slotEnd: string;
  amount: string;
  payment?: { hash: string; explorerUrl: string; validated: boolean };
}

// Client for the order router, through apps/api's /router/* proxy (services/router, owner Lucy).

import { API_BASE, apiFetch } from "./api";

export type Mode = "cheapest" | "balanced" | "fastest";
export const MODES: { value: Mode; label: string }[] = [
  { value: "cheapest", label: "Cheapest" },
  { value: "balanced", label: "Balanced" },
  { value: "fastest", label: "Fastest" },
];

export interface PlanPart {
  gpuId: string;
  label: string;
  provider: string;
  region: string;
  hardware: string;
  capacityType: string;
  share: number;
  priceUsdc: string;
  etaSeconds: number;
}

export interface Plan {
  mode: Mode;
  feasible: boolean;
  reason?: string;
  priceUsdc?: string;
  etaSeconds?: number;
  providers?: string[];
  parts?: PlanPart[];
}

export interface Quote {
  quoteId: string;
  catalogAsOf: string;
  options: Record<Mode, Plan>;
  alternativesConsidered: Record<string, number>;
  why: string | null;
}

export interface Segment {
  gpuId: string;
  label: string;
  provider: string;
  served: number;
  unit: string;
  startedAt: string;
  endedAt: string | null;
}

export interface Move {
  at: string;
  from: string;
  to: string;
  toLabel: string;
  fromProvider: string;
  toProvider: string;
  reason: string;
}

export type TaskType = "inference" | "fine-tune" | "render" | "other";

export interface Order {
  orderId: string;
  kind: "inference" | "rental";
  mode: Mode;
  status: string;
  priceUsdc: string;
  // Price cap: the buyer set aside capUsdc (estimate x (1 + bufferPct)); charged is the actual cost.
  estimateUsdc?: string;
  capUsdc?: string;
  bufferPct?: number;
  taskType?: TaskType | null;
  charged?: string | null;
  pause?: { reason: string; spentUsdc: string; capUsdc: string; neededUsdc: string; at: string } | null;
  topUps?: { amountUsdc: string; hash: string | null; explorerUrl: string | null }[];
  etaSeconds: number;
  plan: Plan;
  payment: { hash: string | null; explorerUrl: string | null } | null;
  segments: Segment[];
  moves: Move[];
  progress: { done: number; total: number; unit: string; pct: number };
  settlements: { gpuId: string; amountUsdc: string; hash?: string | null; explorerUrl?: string | null }[];
  refund: { amountUsdc: string; hash: string | null; explorerUrl: string | null } | null;
  output: string[];
}

export interface OrderRequest {
  kind: "inference" | "rental";
  mode?: Mode;
  bufferPct?: 10 | 25 | 50;
  taskType?: TaskType;
  deadlineSeconds?: number;
  minutes?: number;
  maxTokens?: number;
  tokens?: number;
  requests?: number | { role: string; content: string }[][];
}

export const quote = (o: OrderRequest) =>
  apiFetch<Quote>("/router/quote", { method: "POST", body: JSON.stringify(o) });

export const createOrder = (o: OrderRequest) =>
  apiFetch<Order>("/router/orders", { method: "POST", body: JSON.stringify(o) });

export const getOrder = (id: string) => apiFetch<Order>(`/router/orders/${id}`);

export const listOrders = () => apiFetch<{ orders: Order[] }>("/router/orders?limit=20");

// A paused order (its price cap was reached) continues once more is set aside, or is cancelled.
export const raiseCap = (id: string, capUsdc: number) =>
  apiFetch<Order>(`/router/orders/${id}/cap`, { method: "POST", body: JSON.stringify({ capUsdc }) });
export const cancelOrder = (id: string) => apiFetch<Order>(`/router/orders/${id}/cancel`, { method: "POST", body: "{}" });

export const orderEventsUrl = (id: string) => `${API_BASE}/router/orders/${id}/events`;

export interface CatalogOffer {
  key: string;
  provider: string;
  region: string;
  instanceType: string;
  gpuModel: string;
  gpuCount: number;
  capacityType: string;
  pricePerHourUsd: number;
  pricePerGpuHourUsd: number;
  priceSource: string;
  availability: { status: string; count: number | null; score: number | null };
  interruptionRatePerHour: number;
  warningWindowSeconds: number;
  asOf: string;
  executable: boolean;
}

export const catalog = () =>
  apiFetch<{ catalogAsOf: string; count: number; offers: CatalogOffer[] }>("/router/catalog");

export interface FleetGpu {
  id: string;
  label: string;
  provider: string;
  region: string;
  hardware: string;
  capacityType: string;
  pricePerHourUsdc: string;
  interruptible: boolean;
  warningWindowSeconds: number;
  state: { available: boolean; reason: string | null; activeJobs: number; returnsAt: string | null };
}

export const fleet = () => apiFetch<FleetGpu[]>("/router/fleet");

export const reclaim = (id: string, adminKey: string, warningSeconds?: number) =>
  apiFetch<{ affectedOrders: string[] }>(`/router/fleet/${id}/reclaim`, {
    method: "POST",
    headers: adminKey ? { "X-MS-Admin-Key": adminKey } : {},
    body: JSON.stringify(warningSeconds === undefined ? {} : { warningSeconds }),
  });

export interface RoutedChat {
  choices: { message: { content: string } }[];
  usage: { completion_tokens: number };
  x_ms: { order_id: string; priority: Mode; price_usdc: string; gpus: string[]; providers: string[]; moves: Move[] };
}

// The api picks who pays (the signed-in account, or the developer playground account).
export const chatRouted = (content: string, priority: Mode) =>
  apiFetch<RoutedChat>("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "Qwen/Qwen3-1.7B", messages: [{ role: "user", content }], max_tokens: 160, priority }),
  });

const PROVIDERS: Record<string, string> = {
  moonshift: "Moonshift",
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
  oracle: "Oracle",
  lambda: "Lambda",
  runpod: "RunPod",
  vast: "Vast.ai",
  coreweave: "CoreWeave",
};

export const providerName = (p: string) => PROVIDERS[p] ?? p;

// "8 s", "4 min", "1 h 5 min"
export function fmtEta(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

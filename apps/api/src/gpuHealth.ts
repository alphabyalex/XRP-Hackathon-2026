// Which GPUs are listed: a GPU appears on Market, Borrow, Portfolio and the
// router only while its endpoint (GPU_X_VLLM_URL in .env) answers a health
// check. One endpoint cannot be counted as multiple physical cards. The
// registry (packages/shared GPUS) keeps every GPU; the rest stay hidden and
// appear on their own once their endpoint is set and healthy.

import { GPUS, type GpuId } from "@moonshift/shared";

// The mock GPU, served by the in-process worker. Remove it once two real GPUs answer.
export const MOCK_GPUS: ReadonlySet<GpuId> = new Set<GpuId>();
const CHECK_EVERY_MS = 60_000;
const TIMEOUT_MS = 4_000;

export interface GpuHealth {
  gpuId: GpuId;
  kind: "real" | "mock" | "hidden";
  ok: boolean;
  model: string | null; // what the endpoint says it serves
  latencyMs: number | null;
  checkedAt: string | null;
  error: string | null;
}

export const endpointEnv = (gpuId: string) => `${gpuId.toUpperCase().replace(/-/g, "_")}_VLLM_URL`;
export const normalizeGpuEndpoint = (value: string) => value.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
const endpointOf = (gpuId: string) => normalizeGpuEndpoint(process.env[endpointEnv(gpuId)] ?? "");

const state = new Map<GpuId, GpuHealth>();

async function check(gpuId: GpuId): Promise<GpuHealth> {
  const url = endpointOf(gpuId);
  if (!url) {
    return { gpuId, kind: MOCK_GPUS.has(gpuId) ? "mock" : "hidden", ok: MOCK_GPUS.has(gpuId), model: null, latencyMs: null, checkedAt: null, error: null };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id: string; root?: string }[] };
    const m = body.data?.[0];
    if (!m?.id) throw new Error("No served model reported");
    const canonical = process.env[`${gpuId.toUpperCase().replace(/-/g, "_")}_MODEL_ID`]?.trim()
      || (gpuId === "gpu-a" ? "Qwen/Qwen2.5-1.5B-Instruct" : "");
    if (!canonical || (m.root ?? m.id) !== canonical) throw new Error("Served model does not match verified model");
    // vLLM reports the real weights in `root` when they are served under another name.
    return { gpuId, kind: "real", ok: true, model: m?.root ?? m?.id ?? null, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(), error: null };
  } catch (e) {
    // An endpoint that is set but down hides the GPU (a mock GPU stays listed as the mock).
    const err = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message.slice(0, 120);
    return { gpuId, kind: MOCK_GPUS.has(gpuId) ? "mock" : "hidden", ok: MOCK_GPUS.has(gpuId), model: null, latencyMs: null, checkedAt: new Date().toISOString(), error: err };
  }
}

let running: Promise<void> | null = null;
export function refreshHealth(): Promise<void> {
  if (!running) {
    const endpoints = new Set<string>();
    const enabled = new Set((process.env.GPU_NODES ?? "gpu-a,gpu-b").split(",").map(id => id.trim()));
    running = Promise.all(GPUS.map(async (g) => {
      if (!enabled.has(g.id)) {
        state.set(g.id, { gpuId: g.id, kind: "hidden", ok: false, model: null, latencyMs: null,
          checkedAt: new Date().toISOString(), error: "not_enabled" });
        return;
      }
      const endpoint = endpointOf(g.id);
      if (endpoint && endpoints.has(endpoint)) {
        state.set(g.id, { gpuId: g.id, kind: "hidden", ok: false, model: null, latencyMs: null,
          checkedAt: new Date().toISOString(), error: "duplicate_endpoint" });
        return;
      }
      if (endpoint) endpoints.add(endpoint);
      state.set(g.id, await check(g.id));
    }))
      .then(() => undefined)
      .finally(() => {
        running = null;
      });
  }
  return running;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startHealthChecks(): Promise<void> {
  if (!timer) timer = setInterval(() => void refreshHealth(), CHECK_EVERY_MS);
  return refreshHealth();
}

export function gpuHealth(): GpuHealth[] {
  return GPUS.map((g) => state.get(g.id) ?? { gpuId: g.id, kind: MOCK_GPUS.has(g.id) ? "mock" : "hidden", ok: MOCK_GPUS.has(g.id), model: null, latencyMs: null, checkedAt: null, error: null });
}

export function isListed(gpuId: string): boolean {
  return gpuHealth().some((h) => h.gpuId === gpuId && h.ok);
}

export function listedGpus() {
  return GPUS.filter((g) => isListed(g.id));
}

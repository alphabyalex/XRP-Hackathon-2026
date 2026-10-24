// Service-to-service HTTP with the shared internal key and a short timeout.
// Callers catch ServiceUnavailable and fall back to their contract-shaped
// mock, labeled simulated, so the demo keeps running when a Python service
// is down.

export class ServiceUnavailable extends Error {
  constructor(
    public service: string,
    message: string
  ) {
    super(`${service}: ${message}`);
  }
}

export function internalHeaders(json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-MS-Internal-Key": process.env.INTERNAL_API_KEY ?? "",
  };
}

export async function serviceJson<T>(
  service: string,
  url: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: internalHeaders(init.body !== undefined),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ServiceUnavailable(service, `HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ServiceUnavailable) throw e;
    throw new ServiceUnavailable(service, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

// Which sources answered recently, for GET /health/services and the UI badge.
const lastSource = new Map<string, "live" | "mock" | "mock-fallback">();
export function noteSource(service: string, source: "live" | "mock" | "mock-fallback"): void {
  lastSource.set(service, source);
}
export function sources(): Record<string, string> {
  return Object.fromEntries(lastSource);
}

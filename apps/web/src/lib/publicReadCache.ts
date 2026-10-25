// Only public, account-independent reads belong here. Wallet and money writes
// always reach the server. Values retain their source timestamps.
export function isPublicRead(path: string, init?: RequestInit): boolean {
  if ((init?.method ?? "GET").toUpperCase() !== "GET" || init?.signal || init?.headers || init?.cache === "no-store") return false;
  return /^\/(?:gpus(?:\/gpu-[a-h](?:\/stats)?)?|catalog\/gpus|models|router\/(?:fleet|catalog)|pricing\/resources|lending\/(?:base-apr|markets))(?:\?[^#]*)?$/.test(path);
}

type Entry = { value?: unknown; at: number; pending?: Promise<unknown> };
export function publicReadCache(freshMs = 1500, maxStaleMs = 8000, capacity = 128, clock = Date.now) {
  const entries = new Map<string, Entry>();
  let generation = 0;
  function load<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const old = entries.get(key);
    if (old?.pending) return old.pending as Promise<T>;
    const started = generation;
    const pending = Promise.resolve().then(fn).then(value => {
      if (generation === started) {
        entries.delete(key);
        entries.set(key, { value, at: clock() });
        while (entries.size > capacity) entries.delete(entries.keys().next().value!);
      }
      return value;
    }, error => {
      if (generation === started) {
        if (old?.value !== undefined) entries.set(key, { value: old.value, at: old.at });
        else entries.delete(key);
      }
      throw error;
    });
    entries.set(key, { ...old, at: old?.at ?? 0, pending });
    return pending;
  }
  return {
    get<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const e = entries.get(key);
      const age = e?.value !== undefined ? clock() - e.at : Infinity;
      if (age < freshMs) return Promise.resolve(e!.value as T);
      if (age < maxStaleMs) {
        void load(key, fn).catch(() => {});
        return Promise.resolve(e!.value as T);
      }
      return load(key, fn);
    },
    invalidate() { generation++; entries.clear(); },
  };
}

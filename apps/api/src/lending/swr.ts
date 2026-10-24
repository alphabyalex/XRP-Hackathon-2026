// Stale-while-revalidate cache for slow reads (vault rounds on the ledger,
// credit profiles). A fresh entry is served as is; a stale one is served at
// once while one background refresh runs; past maxStaleMs the caller waits.
// Concurrent misses share one load.

const DEBUG = process.env.DEBUG_TIMING === "1";

// Logs label and duration when DEBUG_TIMING=1. Otherwise a no-op wrapper.
export async function timed<T>(label: string, p: Promise<T> | (() => Promise<T>)): Promise<T> {
  if (!DEBUG) return typeof p === "function" ? p() : p;
  const t0 = Date.now();
  try {
    return await (typeof p === "function" ? p() : p);
  } finally {
    console.log(`[timing] ${label} ${Date.now() - t0} ms`);
  }
}

type Entry<T> = { at: number; value?: T; loading?: Promise<T> };

export function swr<T>(name: string, freshMs: number, maxStaleMs: number, keep: (v: T) => boolean = () => true) {
  const entries = new Map<string, Entry<T>>();
  // Bumped on invalidate, so a load that started before a write never stores its pre-write value.
  let gen = 0;

  function load(key: string, fn: () => Promise<T>): Promise<T> {
    const e = entries.get(key);
    if (e?.loading) return e.loading;
    const started = gen;
    const loading = fn().then(
      (value) => {
        if (started !== gen) return value;
        if (keep(value)) entries.set(key, { at: Date.now(), value });
        else entries.delete(key);
        return value;
      },
      (err) => {
        if (started !== gen) throw err;
        const cur = entries.get(key);
        if (cur?.value !== undefined) entries.set(key, { at: cur.at, value: cur.value });
        else entries.delete(key);
        throw err;
      }
    );
    entries.set(key, { at: e?.at ?? 0, value: e?.value, loading });
    return loading;
  }

  return {
    async get(key: string, fn: () => Promise<T>): Promise<T> {
      const e = entries.get(key);
      const age = e && e.value !== undefined ? Date.now() - e.at : Infinity;
      if (age < freshMs) {
        if (DEBUG) console.log(`[timing] ${name} ${key.slice(0, 12)} fresh`);
        return e!.value as T;
      }
      if (age < maxStaleMs) {
        if (DEBUG) console.log(`[timing] ${name} ${key.slice(0, 12)} stale, refreshing in background`);
        void load(key, fn).catch(() => {});
        return e!.value as T;
      }
      return timed(`${name} ${key.slice(0, 12)} miss`, load(key, fn));
    },
    invalidate(key?: string) {
      gen++;
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}

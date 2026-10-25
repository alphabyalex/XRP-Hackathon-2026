/** Short browser-memory reads. A session change invalidates pending results too. */
export class LendingReadCache {
  private rows = new Map<string, { until: number; value?: unknown; pending?: Promise<unknown> }>();
  private generation = 0;
  constructor(private now: () => number = Date.now) {}
  clear() { this.generation++; this.rows.clear(); }
  read<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const row = this.rows.get(key);
    if (row?.pending) return row.pending as Promise<T>;
    if (row && row.until > this.now()) return Promise.resolve(row.value as T);
    const generation = this.generation;
    const pending = Promise.resolve().then(load).then(value => {
      if (generation === this.generation) {
        this.rows.set(key, { value, until: this.now() + ttl });
        if (this.rows.size > 128) this.rows.delete(this.rows.keys().next().value!);
      }
      return value;
    }, error => {
      if (generation === this.generation) this.rows.delete(key);
      throw error;
    });
    this.rows.set(key, { until: 0, pending });
    return pending;
  }
}

export function lendingInputKey(scope: string, path: string, input: Record<string, unknown>, sourceVersion: string) {
  const normalized = Object.fromEntries(Object.keys(input).sort().map(key => {
    const value = input[key];
    return [key, typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? String(Number(value)) : value];
  }));
  return JSON.stringify([scope, path, normalized, sourceVersion]);
}

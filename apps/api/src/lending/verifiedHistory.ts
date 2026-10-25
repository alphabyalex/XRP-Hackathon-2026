export const isLedgerHash = (value: unknown): value is string => typeof value === "string" && /^[A-F0-9]{64}$/i.test(value);

export function realLoanOrigin(row: { id: string; simulated?: boolean | number; txs: unknown }): string | null {
  if (row.simulated !== false && row.simulated !== 0 || /^mock/i.test(row.id)) return null;
  try {
    const txs = typeof row.txs === "string" ? JSON.parse(row.txs) : row.txs;
    const hash = (txs as Record<string, unknown> | null)?.loanSet;
    return isLedgerHash(hash) ? hash.toUpperCase() : null;
  } catch { return null; }
}

/** Validated transactions are immutable. Transport failures are never retained. */
export function transactionVerifier(load: (hash: string) => Promise<boolean>, now = Date.now) {
  const rows = new Map<string, { until: number; value?: boolean; pending?: Promise<boolean> }>();
  return (hash: string): Promise<boolean> => {
    if (!isLedgerHash(hash)) return Promise.resolve(false);
    const key = hash.toUpperCase(), previous = rows.get(key);
    if (previous?.pending) return previous.pending;
    if (previous?.value !== undefined && previous.until > now()) return Promise.resolve(previous.value);
    const pending = load(key).then(value => {
      rows.set(key, { value, until: now() + (value ? 3600000 : 15000) });
      if (rows.size > 2000) rows.delete(rows.keys().next().value!);
      return value;
    }, () => { rows.delete(key); return false; });
    rows.set(key, { until: 0, pending });
    return pending;
  };
}

export function sampleObservations<T>(rows: T[], max = 720): T[] {
  if (rows.length <= max) return rows;
  return Array.from({ length: max }, (_, i) => rows[Math.round(i * (rows.length - 1) / (max - 1))]);
}

export function ledgerBalanceObservation(vault: { simulated?: boolean; investing?: { debtTotal?: unknown; assetsTotal?: unknown; assetsAvailable?: unknown; coverAvailable?: unknown } | null }) {
  if (vault.simulated !== false || !vault.investing) return null;
  const raw = [vault.investing.debtTotal, vault.investing.assetsTotal, vault.investing.assetsAvailable, vault.investing.coverAvailable];
  if (raw.some(value => value === null || value === undefined || value === "")) return null;
  const [outstanding, assets, available, cover] = raw.map(Number);
  if (![outstanding, assets, available, cover].every(value => Number.isFinite(value) && value >= 0)) return null;
  return { outstanding, assets, available, cover, utilization: assets > 0 ? outstanding / assets * 100 : null };
}

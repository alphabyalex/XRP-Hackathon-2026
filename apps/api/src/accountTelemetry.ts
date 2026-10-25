import { fix6, type CalendarEntry, type RevenueBucket } from "@moonshift/shared";

export interface HoldingTelemetry {
  gpuId: string;
  calendar: CalendarEntry[] | null;
  history: { buckets: RevenueBucket[] } | null;
}

export function ownedGpuIds(registry: readonly { id: string; shareCode: string }[], tokens: Record<string, string>,
  loans: { gpuId: string; status: string; collateralShares: string; ledger: { collateral?: { locked: boolean } | null } | null }[]) {
  return registry.filter(gpu => Number(tokens[gpu.shareCode] ?? 0) > 0 || loans.some(loan =>
    (loan.status === "open" || loan.status === "margin_call") && loan.gpuId === gpu.id &&
    loan.ledger?.collateral?.locked && Number(loan.collateralShares) > 0)).map(gpu => gpu.id);
}

/** A worker outage must not erase the shares recorded in an owner's ledger. */
export async function readHoldingTelemetry(ids: string[], read: {
  calendar: (gpuId: string) => Promise<CalendarEntry[]>;
  revenue: (gpuId: string) => Promise<{ buckets: RevenueBucket[] }>;
}): Promise<HoldingTelemetry[]> {
  return Promise.all(ids.map(async gpuId => {
    const [calendar, history] = await Promise.allSettled([read.calendar(gpuId), read.revenue(gpuId)]);
    return { gpuId, calendar: calendar.status === "fulfilled" ? calendar.value : null,
      history: history.status === "fulfilled" ? history.value : null };
  }));
}

/** Keep only actual metered buckets. Never allocate income using reference rates. */
export function holdingPerformance(gpuId: string, history: HoldingTelemetry["history"], now = Date.now(), calendar: { start: string; end: string }[] | null = null) {
  const buckets = (history?.buckets ?? []).filter(bucket => !bucket.simulated &&
    Number.isFinite(Date.parse(bucket.start)) && Number.isFinite(Date.parse(bucket.end)) &&
    Date.parse(bucket.end) > Date.parse(bucket.start) && Date.parse(bucket.end) <= now &&
    Number.isFinite(Number(bucket.revenue)) && Number(bucket.revenue) >= 0);
  const days = new Map<string, { revenue: number; active: number; minutes: number }>();
  for (const bucket of buckets) {
    const date = bucket.start.slice(0, 10), day = days.get(date) ?? { revenue: 0, active: 0, minutes: 0 };
    const minutes = (Date.parse(bucket.end) - Date.parse(bucket.start)) / 60000;
    day.revenue += Number(bucket.revenue);
    if (Number.isFinite(Number(bucket.utilizationPct))) {
      day.active += Number(bucket.utilizationPct) * minutes;
      day.minutes += minutes;
    }
    days.set(date, day);
  }
  const last = buckets.filter(bucket => Date.parse(bucket.end) > now - 86400000);
  const spans = (calendar ?? []).map(row => [Math.max(now - 86400000, Date.parse(row.start)), Math.min(now, Date.parse(row.end))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort(([a], [b]) => a - b);
  let busy = 0, end = now - 86400000;
  for (const [start, finish] of spans) { busy += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
  return { gpuId, days: [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-7).map(([date, day]) => ({
    date, revenue: fix6(day.revenue), booked: null, inference: null,
    utilization: day.minutes ? fix6(day.active / day.minutes) : null,
  })), revenue24h: last.length ? fix6(last.reduce((sum, bucket) => sum + Number(bucket.revenue), 0)) : null,
  utilization24h: calendar === null ? null : fix6(busy / 86400000 * 100),
  revenueAvailable: last.length > 0, source: history ? "usage_meter" as const : "unavailable" as const };
}

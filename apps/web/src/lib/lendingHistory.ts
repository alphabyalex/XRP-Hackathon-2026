export const LENDING_RANGES = [{ value: "1h", label: "1h" }, { value: "6h", label: "6h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }] as const;
export type LendingRange = (typeof LENDING_RANGES)[number]["value"];
const windows: Record<LendingRange, number> = { "1h": 3600000, "6h": 6 * 3600000, "24h": 86400000, "7d": 7 * 86400000 };

export function recordedLoan(row: { id?: unknown; simulated?: unknown; txs?: Record<string, unknown> }) {
  return row.simulated === false && !/^mock/i.test(String(row.id ?? "")) && /^[A-F0-9]{64}$/i.test(String(row.txs?.loanSet ?? ""));
}
export function lendingRangePoints<T extends { t: number; v: number }>(points: T[], range: LendingRange, now = Date.now()): T[] {
  const actual = new Map<number, T>();
  for (const point of points) if (Number.isFinite(point.t) && Number.isFinite(point.v) && point.t >= now - windows[range] && point.t <= now + 5000) actual.set(point.t, point);
  return [...actual.values()].sort((a, b) => a.t - b.t);
}

export type LoanBookSort = "newest" | "oldest" | "principal" | "owed" | "apr";
type SortableLoan = { id: string; borrower: string; gpuId: string; state: string; principal: number; outstanding: number | null; apr: number; openedAt: string | null };
export function filterLoanBook<T extends SortableLoan>(rows: T[], input: { search: string; gpu: string; state: string; sort: LoanBookSort }) {
  const needle = input.search.trim().toLowerCase();
  const active = (row: T) => row.state === "open" || row.state === "margin_call" || (row.outstanding ?? 0) > 0;
  const selected = rows.filter(row => (!needle || [row.borrower, row.id, row.gpuId].some(value => value.toLowerCase().includes(needle))) &&
    (input.gpu === "all" || row.gpuId === input.gpu) && (input.state === "all" || (input.state === "active" ? active(row) : input.state === "closed" ? !active(row) : row.state === input.state)));
  const at = (row: T) => Number.isFinite(Date.parse(row.openedAt ?? "")) ? Date.parse(row.openedAt!) : 0;
  return selected.sort((a, b) => {
    if (input.sort === "principal") return b.principal - a.principal || at(b) - at(a);
    if (input.sort === "owed") return (b.outstanding ?? (active(b) ? b.principal : 0)) - (a.outstanding ?? (active(a) ? a.principal : 0)) || at(b) - at(a);
    if (input.sort === "apr") return b.apr - a.apr || at(b) - at(a);
    return input.sort === "oldest" ? at(a) - at(b) : at(b) - at(a);
  });
}

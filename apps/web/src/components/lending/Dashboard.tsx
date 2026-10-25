"use client";
// Lend > Lending dashboard: book totals, live charts and the loan book.
// GET /lending/dashboard and /lending/loanbook when deployed; otherwise the
// totals come from the lending round on the ledger (/vault) and the loans
// from /loans. Outstanding and utilization are charted from the series the
// api returns, else from each live refresh as it arrives.
import type { XlsLoanRecord } from "@moonshift/shared";
import { useEffect, useState } from "react";
import { fmt, shortHash } from "@/lib/format";
import { pct } from "@/lib/lendingApi";
import { LiveBars, LiveLine, useTween, type Bar, type LinePoint } from "../charts";
import { StatusChip, TxLink } from "../LendingBits";
import { Segmented } from "../Segmented";
import { filterLoanBook, lendingRangePoints, LENDING_RANGES, type LendingRange, type LoanBookSort } from "@/lib/lendingHistory";

export type Totals = {
  outstanding: number | null;
  available: number | null;
  utilization: number | null; // percent
  weightedApr: number | null; // percent
  defaults: number | null;
  marginCalls: number | null;
  cover: number | null;
};

export type BookRow = {
  id: string;
  borrower: string;
  gpuId: string;
  principal: number;
  outstanding: number | null;
  apr: number; // fraction
  ltv: number | null;
  marginCallLtv: number | null;
  liquidationLtv: number | null;
  state: string;
  network: string;
  tx: string | null;
  openedAt: string | null;
};

export function rowFromLoan(l: XlsLoanRecord): BookRow {
  return {
    id: l.id,
    borrower: l.borrowerAddress || l.borrower,
    gpuId: l.gpuId,
    principal: Number(l.principal),
    outstanding: l.ledger ? Number(l.ledger.totalValueOutstanding) : null,
    apr: Number(l.apr),
    ltv: l.health ? Number(l.health.ltv) : null,
    marginCallLtv: Number(l.marginCallLtv),
    liquidationLtv: Number(l.liquidationLtv),
    state: l.status,
    network: l.network,
    tx: [l.txs.seize, l.txs.release, l.txs.loanSet].find(hash => /^[A-F0-9]{64}$/i.test(hash ?? "")) ?? null,
    openedAt: l.openedAt,
  };
}

// Owing: an open loan, or one the ledger still carries debt on (a liquidated
// loan before it is cleared counts in the round's outstanding too).
export const owing = (r: BookRow) => r.state === "open" || r.state === "margin_call" || (r.outstanding ?? 0) > 0;

function Tween({ v, d = 2, suffix = "" }: { v: number | null; d?: number; suffix?: string }) {
  const [shown] = useTween([v ?? 0]);
  if (v === null) return <>Loading</>;
  return (
    <>
      {fmt(shown, d)}
      {suffix}
    </>
  );
}

export function Dashboard({
  totals,
  outstandingSeries,
  utilizationSeries,
  rows,
}: {
  totals: Totals;
  outstandingSeries: LinePoint[];
  utilizationSeries: LinePoint[];
  rows: BookRow[] | null;
}) {
  const [range, setRange] = useState<LendingRange>("24h");
  const [search, setSearch] = useState("");
  const [gpu, setGpu] = useState("all");
  const [state, setState] = useState("all");
  const [sort, setSort] = useState<LoanBookSort>("newest");
  const [limit, setLimit] = useState(20);
  useEffect(() => setLimit(20), [search, gpu, state, sort]);
  const now = Date.now();
  const outstanding = lendingRangePoints(outstandingSeries, range, now);
  const utilization = lendingRangePoints(utilizationSeries, range, now);
  const filtered = filterLoanBook(rows ?? [], { search, gpu, state, sort });
  const shown = filtered.slice(0, limit);
  // Every loan's APR at the moment it opened, and principal originated per hour: both from the loans themselves.
  const originations: LinePoint[] = (rows ?? [])
    .filter((r) => r.openedAt)
    .map((r) => ({ t: new Date(r.openedAt!).getTime(), v: r.apr * 100 }));
  const aprPoints = lendingRangePoints(originations, range, now);
  const selectedOriginations = new Set(aprPoints.map(point => point.t));
  const hourly = new Map<number, number>();
  for (const r of rows ?? []) {
    if (!r.openedAt || !selectedOriginations.has(new Date(r.openedAt).getTime())) continue;
    const h = Math.floor(new Date(r.openedAt).getTime() / 3600e3) * 3600e3;
    hourly.set(h, (hourly.get(h) ?? 0) + r.principal);
  }
  const bars: Bar[] = [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

  const stats: { k: string; v: React.ReactNode }[] = [
    { k: "Outstanding", v: <><Tween v={totals.outstanding} /> <small>USDC</small></> },
    { k: "Available to lend", v: <><Tween v={totals.available} /> <small>USDC</small></> },
    { k: "Utilization", v: <Tween v={totals.utilization} suffix="%" /> },
    { k: "Recorded weighted APR", v: totals.weightedApr === null ? "Unavailable" : <Tween v={totals.weightedApr} suffix="%" /> },
    { k: "First-loss cover", v: <><Tween v={totals.cover} /> <small>USDC</small></> },
    { k: "Recorded margin calls", v: <Tween v={totals.marginCalls} d={0} /> },
    { k: "Recorded defaults", v: <Tween v={totals.defaults} d={0} /> },
  ];

  return (
    <div className="dash">
      <div className="dash-stats">
        {stats.map((s) => (
          <div key={s.k}>
            <span>{s.k}</span>
            <b>{s.v}</b>
          </div>
        ))}
      </div>

      <div className="dash-range-head"><div><b>Recorded lending activity</b><span>Refreshes every 5 seconds</span></div>
        <div className="dash-ranges" role="group" aria-label="Chart timeframe"><Segmented options={[...LENDING_RANGES]} value={range} onChange={setRange} /></div>
      </div>
      <div className="dash-charts">
        <div className="trade card">
          <span className="lbl">Outstanding</span>
          <LiveLine points={outstanding} unit="USDC" height={170} label="Recorded outstanding over time" empty="No recorded observations in this range" />
        </div>
        <div className="trade card">
          <span className="lbl">Utilization</span>
          <LiveLine points={utilization} unit="%" height={170} label="Recorded utilization over time" empty="No recorded observations in this range" />
        </div>
        <div className="trade card">
          <span className="lbl">APR of each loan at origination</span>
          <LiveLine points={aprPoints} unit="%" height={170} area={false} label="Validated loan origination APR" empty="No loan originations in this range" />
        </div>
        <div className="trade card">
          <span className="lbl">Principal originated per hour</span>
          <LiveBars bars={bars} unit="USDC" height={170} label="Validated principal originations" empty="No loan originations in this range" />
        </div>
      </div>
      <p className="dash-history-note">Charts use recorded observations and verified loan transactions. Sparse periods stay sparse.</p>

      <h3 className="sub-h dash-h">Loan book</h3>
      <div className="dash-book-controls">
        <label className="dash-book-search">Find borrower or loan<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Address or loan ID" /></label>
        <label>GPU<select value={gpu} onChange={event => setGpu(event.target.value)}><option value="all">All GPUs</option>{[...new Set((rows ?? []).map(row => row.gpuId))].sort().map(id => <option key={id} value={id}>{id.toUpperCase()}</option>)}</select></label>
        <label>State<select value={state} onChange={event => setState(event.target.value)}><option value="all">All states</option><option value="active">Owing</option><option value="closed">Closed</option><option value="margin_call">Margin call</option><option value="defaulted">Defaulted</option></select></label>
        <label>Sort by<select aria-label="Sort by" value={sort} onChange={event => setSort(event.target.value as LoanBookSort)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="principal">Largest principal</option><option value="owed">Largest owed</option><option value="apr">Highest APR</option></select></label>
      </div>
      {rows !== null && <p className="dash-history-note">{shown.length} of {filtered.length} matching loans</p>}
      <p className="dash-history-note">Round totals cover the full lending round. This table shows verified recorded loans.</p>
      {rows === null ? (
        <p className="note">Loading the loan book...</p>
      ) : (
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Borrower</th>
                <th>GPU</th>
                <th>State</th>
                <th className="num">Principal</th>
                <th className="num">Owed</th>
                <th className="num">APR</th>
                <th className="num">LTV</th>
                <th className="num">Call / liquidation</th>
                <th>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="note">
                    No verified loans match these filters.
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id} className={owing(r) ? undefined : "closed"}>
                  <td>{shortHash(r.borrower)}</td>
                  <td>{r.gpuId.toUpperCase()}</td>
                  <td>
                    <StatusChip status={r.state} />
                  </td>
                  <td className="num">{fmt(r.principal, 2)}</td>
                  <td className="num">{r.outstanding !== null ? fmt(r.outstanding, 2) : owing(r) ? "" : "0.00"}</td>
                  <td className="num">{pct(r.apr, 2)}</td>
                  <td className="num">{r.ltv !== null ? pct(r.ltv) : ""}</td>
                  <td className="num">
                    {r.marginCallLtv !== null && r.liquidationLtv !== null ? `${pct(r.marginCallLtv, 0)} / ${pct(r.liquidationLtv, 0)}` : ""}
                  </td>
                  <td>
                    <TxLink network={r.network} hash={r.tx} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > limit && <button type="button" className="dash-more" onClick={() => setLimit(value => value + 20)}>Show 20 more loans</button>}
    </div>
  );
}

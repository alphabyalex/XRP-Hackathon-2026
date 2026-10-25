"use client";
// Lend > Lending dashboard: book totals, live charts and the loan book.
// GET /lending/dashboard and /lending/loanbook when deployed; otherwise the
// totals come from the lending round on the ledger (/vault) and the loans
// from /loans. Outstanding and utilization are charted from the series the
// api returns, else from each live refresh as it arrives.
import type { XlsLoanRecord } from "@moonshift/shared";
import { fmt, shortHash } from "@/lib/format";
import { pct } from "@/lib/lendingApi";
import { LiveBars, LiveLine, useTween, type Bar, type LinePoint } from "../charts";
import { StatusChip, TxLink } from "../LendingBits";

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
    tx: l.txs.seize ?? l.txs.release ?? l.txs.loanSet ?? null,
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

// key={length} on each chart: useTween (charts/theme.ts) answers one render
// late when the number of points grows, which draws NaN; a remount avoids it.
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
  const open = (rows ?? []).filter(owing);
  const closed = (rows ?? []).filter((r) => !owing(r)).slice(0, 8);
  // Every loan's APR at the moment it opened, and principal originated per hour: both from the loans themselves.
  const aprPoints: LinePoint[] = (rows ?? [])
    .filter((r) => r.openedAt)
    .map((r) => ({ t: new Date(r.openedAt!).getTime(), v: r.apr * 100 }));
  const hourly = new Map<number, number>();
  for (const r of rows ?? []) {
    if (!r.openedAt) continue;
    const h = Math.floor(new Date(r.openedAt).getTime() / 3600e3) * 3600e3;
    hourly.set(h, (hourly.get(h) ?? 0) + r.principal);
  }
  const bars: Bar[] = [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));

  const stats: { k: string; v: React.ReactNode }[] = [
    { k: "Outstanding", v: <><Tween v={totals.outstanding} /> <small>USDC</small></> },
    { k: "Available to lend", v: <><Tween v={totals.available} /> <small>USDC</small></> },
    { k: "Utilization", v: <Tween v={totals.utilization} suffix="%" /> },
    { k: "Weighted APR", v: totals.weightedApr === null ? "No debt owed" : <Tween v={totals.weightedApr} suffix="%" /> },
    { k: "First-loss cover", v: <><Tween v={totals.cover} /> <small>USDC</small></> },
    { k: "Margin calls", v: <Tween v={totals.marginCalls} d={0} /> },
    { k: "Defaults", v: <Tween v={totals.defaults} d={0} /> },
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

      <div className="dash-charts">
        <div className="trade card">
          <span className="lbl">Outstanding</span>
          <LiveLine key={outstandingSeries.length} points={outstandingSeries} unit="USDC" height={170} label="Outstanding over time" empty="Collecting live points" />
        </div>
        <div className="trade card">
          <span className="lbl">Utilization</span>
          <LiveLine key={utilizationSeries.length} points={utilizationSeries} unit="%" height={170} label="Utilization over time" empty="Collecting live points" />
        </div>
        <div className="trade card">
          <span className="lbl">APR of each loan at origination</span>
          <LiveLine key={aprPoints.length} points={aprPoints} unit="%" height={170} area={false} label="APR over time" empty="No loans yet" />
        </div>
        <div className="trade card">
          <span className="lbl">Principal originated per hour</span>
          <LiveBars key={bars.length} bars={bars} unit="USDC" height={170} label="Originations" empty="No loans yet" />
        </div>
      </div>

      <h3 className="sub-h dash-h">Loan book</h3>
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
              {open.length === 0 && (
                <tr>
                  <td colSpan={9} className="note">
                    Nobody has debt outstanding right now.
                  </td>
                </tr>
              )}
              {[...open, ...closed].map((r) => (
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
      {closed.length > 0 && <p className="note">Closed loans are shown below the open ones, newest first.</p>}
    </div>
  );
}

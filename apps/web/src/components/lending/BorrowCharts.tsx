"use client";
// /borrow charts: LTV at the GPU's real hourly share prices, the payment
// schedule from the quote's terms, and coverage from each live quote.
import type { LoanQuoteApiResponse } from "@moonshift/shared";
import { fmt } from "@/lib/format";
import { pct } from "@/lib/lendingApi";
import { LiveBars, LiveLine, type Bar, type LinePoint } from "../charts";

// Level installment for the quote's terms (rate in tenths of a basis point, per year).
export function schedule(q: LoanQuoteApiResponse): Bar[] {
  const n = q.terms.paymentTotal;
  const interval = q.terms.paymentIntervalSeconds;
  const p = Number(q.principal);
  if (!(n > 0) || !(interval > 0) || !(p > 0)) return [];
  const r = (q.terms.interestRateTenthBps / 100_000) * (interval / (365 * 86400));
  const pay = r > 0 ? (p * r) / (1 - Math.pow(1 + r, -n)) : p / n;
  const start = Date.now();
  return Array.from({ length: n }, (_, i) => ({ t: start + (i + 1) * interval * 1000, v: pay, label: `${i + 1}` }));
}

export function BorrowCharts({
  quote,
  priceHistory,
  coverage,
}: {
  quote: LoanQuoteApiResponse | null;
  priceHistory: { t: number; price: number }[];
  coverage: LinePoint[];
}) {
  const q = quote?.quote;
  const principal = Number(quote?.principal ?? 0);
  const shares = Number(quote?.collateralShares ?? 0);
  const ltv: LinePoint[] =
    quote && principal > 0 && shares > 0
      ? priceHistory.filter((p) => p.price > 0).map((p) => ({ t: p.t, v: (principal / (shares * p.price)) * 100 }))
      : [];
  const bars = quote ? schedule(quote) : [];
  const total = bars.reduce((s, b) => s + b.v, 0);

  return (
    <div className="bw-charts">
      <div className="trade card">
        <span className="lbl">LTV at the GPU&apos;s share price, last hours</span>
        <LiveLine
          key={`ltv${ltv.length}`}
          points={ltv}
          unit="%"
          height={150}
          area={false}
          label="LTV over time"
          format={(v) => fmt(v, 1)}
          empty={quote ? "Waiting for price history" : "Enter an amount to see it"}
        />
        {q && (
          <p className="note">
            Margin call at {pct(q.marginCallLtv, 0)}, liquidation at {pct(q.liquidationLtv, 0)}.
          </p>
        )}
      </div>
      <div className="trade card">
        <span className="lbl">Payment schedule</span>
        <LiveBars key={`pay${bars.length}`} bars={bars} unit="USDC" height={150} label="Payment schedule" format={(v) => fmt(v, 2)} empty="Enter an amount to see it" />
        {bars.length > 0 && (
          <p className="note">
            {bars.length} payments of {fmt(bars[0].v, 2)} USDC, {fmt(total, 2)} USDC in all.
          </p>
        )}
      </div>
      <div className="trade card">
        <span className="lbl">Dividend coverage, live</span>
        <LiveLine
          key={`cov${coverage.length}`}
          points={coverage}
          unit="x"
          height={150}
          area={false}
          label="Coverage over time"
          format={(v) => fmt(v, 2)}
          empty={quote ? `${fmt(Number(q?.coverageRatio ?? 0), 2)}x now. Each new quote adds a point.` : "Enter an amount to see it"}
        />
        <p className="note">How many times the GPU&apos;s dividends on these shares cover each payment.</p>
      </div>
    </div>
  );
}

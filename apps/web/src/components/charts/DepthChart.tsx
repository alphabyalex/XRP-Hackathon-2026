"use client";
// Order book depth: cumulative size of the real bids (left, up color) and asks (right, down color)
// around the midpoint. Levels tween as the book changes.
import { chartTheme, fmtNum, useTween, useWidth, type Fmt } from "./theme";

export interface Level {
  price: number;
  qty: number;
}

export function DepthChart({
  bids,
  asks,
  height = 200,
  format = fmtNum,
  label = "Order book depth",
  empty = "No orders on the book",
}: {
  bids: Level[];
  asks: Level[];
  height?: number;
  format?: Fmt;
  label?: string;
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const b = [...bids].filter((l) => l.qty > 0).sort((x, y) => y.price - x.price);
  const a = [...asks].filter((l) => l.qty > 0).sort((x, y) => x.price - y.price);
  const cum = (ls: Level[]) => ls.reduce<number[]>((acc, l) => [...acc, (acc[acc.length - 1] ?? 0) + l.qty], []);
  const cb = useTween(cum(b));
  const ca = useTween(cum(a));
  if (!b.length && !a.length) {
    return (
      <div ref={ref} className="chart-empty" style={{ height }}>
        {empty}
      </div>
    );
  }
  const pad = { l: 6, r: 6, t: 10, b: 22 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const prices = [...b, ...a].map((l) => l.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = Math.max(hi - lo, hi * 0.02 || 1);
  const x = (p: number) => pad.l + ((p - (lo - span * 0.05)) / (span * 1.1)) * iw;
  const max = Math.max(cb[cb.length - 1] ?? 0, ca[ca.length - 1] ?? 0, 1e-9);
  const y = (q: number) => pad.t + ih - (q / max) * ih;
  const step = (ls: Level[], cs: number[]) => {
    if (!ls.length) return "";
    let d = `M${x(ls[0].price).toFixed(1)},${pad.t + ih}`;
    ls.forEach((l, i) => {
      d += `L${x(l.price).toFixed(1)},${y(cs[i - 1] ?? 0).toFixed(1)}L${x(l.price).toFixed(1)},${y(cs[i] ?? 0).toFixed(1)}`;
    });
    return d + `L${x(ls[ls.length - 1].price).toFixed(1)},${pad.t + ih}Z`;
  };
  const mid = b.length && a.length ? (b[0].price + a[0].price) / 2 : null;
  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={label}>
        <line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih} y2={pad.t + ih} stroke={chartTheme.rule} />
        <path d={step(b, cb)} fill={chartTheme.up} opacity={0.18} stroke={chartTheme.up} strokeWidth={1.5} />
        <path d={step(a, ca)} fill={chartTheme.down} opacity={0.18} stroke={chartTheme.down} strokeWidth={1.5} />
        {mid !== null && <line x1={x(mid)} x2={x(mid)} y1={pad.t} y2={pad.t + ih} stroke={chartTheme.rule2} strokeDasharray="3 3" />}
        <text x={pad.l} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} fontFamily={chartTheme.mono}>
          {format(lo)}
        </text>
        <text x={pad.l + iw} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} fontFamily={chartTheme.mono} textAnchor="end">
          {format(hi)}
        </text>
      </svg>
      <div className="chart-readout">
        {mid !== null ? `Mid ${format(mid)}` : b.length ? `Best bid ${format(b[0].price)}` : `Best ask ${format(a[0].price)}`}
      </div>
    </div>
  );
}

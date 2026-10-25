"use client";
// A live line (or area) over time. Give it real points; when more arrive the line extends and
// the scale eases to fit. Hover shows the value at a time. No points shows an empty state.
import { useState } from "react";
import { chartTheme, extent, fmtNum, useTween, useWidth, type Fmt } from "./theme";

export interface LinePoint {
  t: number; // ms since epoch
  v: number;
}

const timeFmt = (t: number, span: number) =>
  new Date(t).toLocaleString("en-US", span > 2 * 86400e3 ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" });

export function LiveLine({
  points,
  height = 220,
  format = fmtNum,
  unit,
  area = true,
  color = chartTheme.accent,
  label = "Live chart",
  empty = "Waiting for data",
}: {
  points: LinePoint[];
  height?: number;
  format?: Fmt;
  unit?: string;
  area?: boolean;
  color?: string;
  label?: string;
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const ys = useTween(sorted.map((p) => p.v));
  const ts = sorted.map((p) => p.t);
  const pad = { l: 8, r: 64, t: 12, b: 24 };
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = Math.max(1, height - pad.t - pad.b);

  if (sorted.length < 2) {
    return (
      <div ref={ref} className="chart-empty" style={{ height }}>
        {sorted.length === 1 ? `${format(sorted[0].v)}${unit ? ` ${unit}` : ""}` : empty}
      </div>
    );
  }
  const [lo, hi] = extent(ys);
  const t0 = ts[0];
  const span = Math.max(1, ts[ts.length - 1] - t0);
  const x = (t: number) => pad.l + ((t - t0) / span) * iw;
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const line = ys.map((v, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const fill = `${line}L${x(ts[ts.length - 1]).toFixed(1)},${pad.t + ih}L${x(t0).toFixed(1)},${pad.t + ih}Z`;
  const last = ys[ys.length - 1];
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const hi_ = hover !== null ? hover : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - pad.l) / iw) * span;
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[best] - t)) best = i;
    setHover(best);
  }

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={chartTheme.rule} />
            <text x={pad.l + iw + 8} y={y(v) + 4} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} fontFamily={chartTheme.mono}>
              {format(v)}
            </text>
          </g>
        ))}
        {area && <path d={fill} fill={color} opacity={0.08} />}
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(ts[ts.length - 1])} cy={y(last)} r={3.5} fill={color} />
        <text x={pad.l} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize}>
          {timeFmt(t0, span)}
        </text>
        <text x={pad.l + iw} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} textAnchor="end">
          {timeFmt(ts[ts.length - 1], span)}
        </text>
        {hi_ !== null && (
          <g>
            <line x1={x(ts[hi_])} x2={x(ts[hi_])} y1={pad.t} y2={pad.t + ih} stroke={chartTheme.rule2} />
            <circle cx={x(ts[hi_])} cy={y(ys[hi_])} r={3} fill={chartTheme.ink} />
          </g>
        )}
      </svg>
      <div className="chart-readout" aria-live="polite">
        {hi_ !== null
          ? `${timeFmt(ts[hi_], 0)} · ${format(sorted[hi_].v)}${unit ? ` ${unit}` : ""}`
          : `${format(sorted[sorted.length - 1].v)}${unit ? ` ${unit}` : ""}`}
      </div>
    </div>
  );
}

"use client";
// Live bars (per hour or per day). Bar heights tween when values change; a new bar grows in.
import { useState } from "react";
import { chartTheme, fmtNum, useTween, useWidth, type Fmt } from "./theme";

export interface Bar {
  t: number; // ms since epoch, the bar's start
  v: number;
  label?: string; // axis label; defaults to the hour or the weekday
}

export function LiveBars({
  bars,
  height = 200,
  format = fmtNum,
  unit,
  color = chartTheme.accent,
  label = "Live bars",
  empty = "Waiting for data",
}: {
  bars: Bar[];
  height?: number;
  format?: Fmt;
  unit?: string;
  color?: string;
  label?: string;
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const vs = useTween(sorted.map((b) => b.v));
  if (!sorted.length) {
    return (
      <div ref={ref} className="chart-empty" style={{ height }}>
        {empty}
      </div>
    );
  }
  const pad = { l: 4, r: 4, t: 10, b: 22 };
  const ih = height - pad.t - pad.b;
  const max = Math.max(...vs, 1e-9);
  const slot = (width - pad.l - pad.r) / sorted.length;
  const bw = Math.max(2, slot * 0.68);
  const span = sorted.length > 1 ? sorted[sorted.length - 1].t - sorted[0].t : 0;
  const axis = (b: Bar) =>
    b.label ?? new Date(b.t).toLocaleString("en-US", span > 2 * 86400e3 ? { weekday: "short" } : { hour: "numeric" });
  const every = Math.max(1, Math.ceil(sorted.length / Math.max(1, Math.floor(width / 56))));
  const shown = hover ?? sorted.length - 1;

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke={chartTheme.rule} />
        {sorted.map((b, i) => {
          const h = (Math.max(0, vs[i]) / max) * ih;
          const x = pad.l + i * slot + (slot - bw) / 2;
          return (
            <g key={b.t} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
              <rect x={x} y={pad.t + ih - h} width={bw} height={h} rx={2} fill={color} opacity={hover === null || hover === i ? 1 : 0.45} />
              {i % every === 0 && (
                <text x={x + bw / 2} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} textAnchor="middle">
                  {axis(b)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-readout" aria-live="polite">
        {axis(sorted[shown])} · {format(sorted[shown].v)}
        {unit ? ` ${unit}` : ""}
      </div>
    </div>
  );
}

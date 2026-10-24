"use client";
import { useId, useState } from "react";

export interface HistoryLine {
  key: string;
  label: string;
  points: { time: string; value: number }[];
  color?: string;
  dashed?: boolean;
}

const day = (time: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(time));

export function HistoryChart({ lines, label, unit, zeroBaseline = false }: {
  lines: HistoryLine[]; label: string; unit: string; zeroBaseline?: boolean;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const times = [...new Set(lines.flatMap(line => line.points.map(p => p.time)))].sort();
  const values = lines.flatMap(line => line.points.map(p => p.value));
  if (!times.length) return <p className="account-muted">No price history available yet</p>;
  const min = zeroBaseline ? 0 : Math.max(0, Math.min(...values) * 0.92);
  const max = Math.max(min + 0.01, Math.max(...values) * 1.08);
  const first = Date.parse(times[0]);
  const span = Math.max(1, Date.parse(times[times.length - 1]) - first);
  const x = (time: string) => times.length === 1 ? 400 : 70 + (Date.parse(time) - first) / span * 640;
  const y = (value: number) => 200 - (value - min) / (max - min) * 172;
  const format = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
  const index = hover === null ? times.length - 1 : Math.min(hover, times.length - 1);
  const cursor = times[index];
  return <div className="portfolio-history">
    <svg viewBox="0 0 760 250" role="img" aria-label={label} aria-describedby={id} tabIndex={0}
      onMouseMove={event => {
        const box = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - box.left) / box.width * 760;
        let closest = 0;
        times.forEach((time, i) => { if (Math.abs(x(time) - position) < Math.abs(x(times[closest]) - position)) closest = i; });
        setHover(closest);
      }} onMouseLeave={() => setHover(null)}
      onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); setHover(Math.max(0, Math.min(times.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))));
        }
      }}>
      {[min, (min + max) / 2, max].map(value => <g key={value}>
        <line x1="70" x2="710" y1={y(value)} y2={y(value)} stroke="var(--rule)"/>
        <text x="58" y={y(value) + 5} textAnchor="end" fill="var(--ink3)" fontSize="14">{format(value)}</text>
      </g>)}
      {lines.map(line => <g key={line.key}>
        {line.points.length > 1 && <polyline points={line.points.map(p => `${x(p.time)},${y(p.value)}`).join(" ")}
          fill="none" stroke={line.color ?? "var(--ink)"} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray={line.dashed ? "5 5" : undefined}/>}
        {line.points.length === 1 && <circle cx={x(line.points[0].time)} cy={y(line.points[0].value)} r="4" fill={line.color ?? "var(--ink)"}/>}
      </g>)}
      {hover !== null && <line x1={x(cursor)} x2={x(cursor)} y1="20" y2="205" stroke="var(--ink3)" strokeDasharray="3 4"/>}
      <text x="70" y="237" fill="var(--ink3)" fontSize="14">{day(times[0])}</text>
      {times.length > 1 && <text x="710" y="237" textAnchor="end" fill="var(--ink3)" fontSize="14">{day(times[times.length - 1])}</text>}
    </svg>
    <div id={id} className="portfolio-history-readout" aria-live="polite">
      <span>{day(cursor)}</span>
      {lines.map(line => {
        const point = line.points.find(p => p.time === cursor);
        return point ? <span key={line.key}>{line.label} <b>{format(point.value)} {unit}</b></span> : null;
      })}
    </div>
  </div>;
}

"use client";
import type { BorrowScenario } from "@/lib/borrowingScenarios";
import { fmt } from "@/lib/format";
import styles from "./BorrowPanel.module.css";

export function BorrowEstimateChart({ points, selected, onSelect, empty }: {
  points: BorrowScenario[]; selected: number; onSelect: (index: number) => void; empty: string;
}) {
  if (!points.length) return <div className={styles.empty}>{empty}</div>;
  const width = 360, height = 150, left = 8, right = 52, top = 12, bottom = 28;
  const maxCost = Math.max(...points.map(p => p.interest), 0.000001) * 1.12;
  const maxShares = Math.max(points[points.length - 1].shares, 1);
  const x = (shares: number) => left + (shares - 1) / Math.max(1, maxShares - 1) * (width - left - right);
  const y = (interest: number) => top + (1 - interest / maxCost) * (height - top - bottom);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.shares).toFixed(2)},${y(p.interest).toFixed(2)}`).join(" ");
  const active = points[Math.min(selected, points.length - 1)];
  return <div className={styles.chart}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Estimated interest in USDC by shares locked"
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const position = ((event.clientX - rect.left) / rect.width * width - left) / (width - left - right);
        onSelect(Math.max(0, Math.min(points.length - 1, Math.round(position * (points.length - 1)))));
      }}>
      {[0.25, 0.6, 0.95].map(fraction => <g key={fraction}>
        <line x1={left} x2={width - right} y1={y(maxCost * fraction)} y2={y(maxCost * fraction)} stroke="var(--rule)" />
        <text x={width - right + 7} y={y(maxCost * fraction) + 3} className={styles.axis}>{fmt(maxCost * fraction, maxCost < 0.1 ? 4 : 2)}</text>
      </g>)}
      <path d={`${line} L${x(maxShares)},${height - bottom} L${left},${height - bottom} Z`} fill="var(--accent)" opacity="0.08" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <line x1={x(active.shares)} x2={x(active.shares)} y1={top} y2={height - bottom} stroke="var(--ink)" opacity="0.2" />
      <circle cx={x(active.shares)} cy={y(active.interest)} r="4" fill="var(--ink)" />
      <text x={left} y={height - 8} className={styles.axis}>1 share</text>
      <text x={width - right} y={height - 8} textAnchor="end" className={styles.axis}>{fmt(maxShares, 0)} shares locked</text>
    </svg>
    <input className={styles.pointSlider} type="range" min="0" max={points.length - 1} value={Math.min(selected, points.length - 1)}
      aria-label="Inspect a borrowing scenario" onChange={event => onSelect(Number(event.target.value))} />
  </div>;
}

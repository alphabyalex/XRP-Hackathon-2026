"use client";
// A small trend line for tables and stat tiles. Points are real values in order; it tweens when
// a new one arrives. Empty or single-point input draws nothing rather than a made-up line.
import { chartTheme, extent, useTween } from "./theme";

export function Sparkline({
  points,
  width = 96,
  height = 28,
  color,
  label,
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}) {
  const shown = useTween(points);
  if (shown.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const [lo, hi] = extent(shown, 0.12);
  const x = (i: number) => (i / (shown.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 1 - ((v - lo) / (hi - lo)) * (height - 2);
  const d = shown.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const rising = shown[shown.length - 1] >= shown[0];
  const stroke = color ?? (rising ? chartTheme.up : chartTheme.down);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? "Trend"} style={{ display: "block", overflow: "visible" }}>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(shown.length - 1)} cy={y(shown[shown.length - 1])} r={2} fill={stroke} />
    </svg>
  );
}

"use client";
// Candlesticks from real trades (or price samples), bucketed into 1m, 5m, 1h or 1d. A bucket with
// no trade is skipped, never filled with a made-up price. The newest candle updates in place.
import { useMemo, useState } from "react";
import { chartTheme, extent, fmtNum, useTween, useWidth, type Fmt } from "./theme";

export type CandleInterval = "1m" | "5m" | "1h" | "1d";
export const CANDLE_INTERVALS: CandleInterval[] = ["1m", "5m", "1h", "1d"];
const MS: Record<CandleInterval, number> = { "1m": 60e3, "5m": 300e3, "1h": 3600e3, "1d": 86400e3 };

export interface Tick {
  t: number; // ms since epoch
  price: number;
  qty?: number;
}
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function toCandles(ticks: Tick[], interval: CandleInterval): Candle[] {
  const size = MS[interval];
  const out = new Map<number, Candle>();
  for (const tk of [...ticks].sort((a, b) => a.t - b.t)) {
    const t = Math.floor(tk.t / size) * size;
    const c = out.get(t);
    if (!c) out.set(t, { t, o: tk.price, h: tk.price, l: tk.price, c: tk.price, v: tk.qty ?? 0 });
    else {
      c.h = Math.max(c.h, tk.price);
      c.l = Math.min(c.l, tk.price);
      c.c = tk.price;
      c.v += tk.qty ?? 0;
    }
  }
  return [...out.values()];
}

export function Candles({
  ticks,
  candles,
  interval: initial = "5m",
  height = 260,
  format = fmtNum,
  maxCandles = 60,
  showIntervals = true,
  label = "Price candles",
  empty = "No trades yet",
}: {
  ticks?: Tick[];
  candles?: Candle[]; // already bucketed (overrides ticks)
  interval?: CandleInterval;
  height?: number;
  format?: Fmt;
  maxCandles?: number;
  showIntervals?: boolean;
  label?: string;
  empty?: string;
}) {
  const [interval, setInterval_] = useState<CandleInterval>(initial);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => (candles ?? toCandles(ticks ?? [], interval)).slice(-maxCandles), [candles, ticks, interval, maxCandles]);
  const flat = useTween(data.flatMap((c) => [c.o, c.h, c.l, c.c]));
  const shownCandles = data.map((c, i) => ({ ...c, o: flat[i * 4] ?? c.o, h: flat[i * 4 + 1] ?? c.h, l: flat[i * 4 + 2] ?? c.l, c: flat[i * 4 + 3] ?? c.c }));

  const picker = showIntervals && (
    <div className="chart-intervals" role="radiogroup" aria-label="Candle size">
      {CANDLE_INTERVALS.map((iv) => (
        <button key={iv} type="button" role="radio" aria-checked={iv === interval} className={iv === interval ? "on" : undefined} onClick={() => setInterval_(iv)}>
          {iv}
        </button>
      ))}
    </div>
  );
  if (!data.length) {
    return (
      <div ref={ref} className="chart">
        {picker}
        <div className="chart-empty" style={{ height }}>
          {empty}
        </div>
      </div>
    );
  }
  const pad = { l: 6, r: 64, t: 10, b: 22 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const [lo, hi] = extent(shownCandles.flatMap((c) => [c.h, c.l]));
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const slot = iw / Math.max(data.length, 12);
  const bw = Math.max(2, Math.min(14, slot * 0.6));
  const ticksY = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const cur = shownCandles[hover ?? shownCandles.length - 1];
  const tLabel = (t: number) =>
    new Date(t).toLocaleString("en-US", interval === "1d" ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" });

  return (
    <div ref={ref} className="chart">
      {picker}
      <svg width={width} height={height} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticksY.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={chartTheme.rule} />
            <text x={pad.l + iw + 8} y={y(v) + 4} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} fontFamily={chartTheme.mono}>
              {format(v)}
            </text>
          </g>
        ))}
        {shownCandles.map((c, i) => {
          const cx = pad.l + iw - (shownCandles.length - i - 0.5) * slot;
          const up = c.c >= c.o;
          const col = up ? chartTheme.up : chartTheme.down;
          const top = y(Math.max(c.o, c.c));
          const h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          return (
            <g key={c.t} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={pad.t} width={slot} height={ih} fill="transparent" />
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} />
              <rect x={cx - bw / 2} y={top} width={bw} height={h} fill={col} rx={1} />
            </g>
          );
        })}
        <text x={pad.l} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize}>
          {tLabel(data[0].t)}
        </text>
        <text x={pad.l + iw} y={height - 6} fill={chartTheme.ink3} fontSize={chartTheme.axisSize} textAnchor="end">
          {tLabel(data[data.length - 1].t)}
        </text>
      </svg>
      <div className="chart-readout" aria-live="polite">
        {tLabel(cur.t)} · O {format(cur.o)} H {format(cur.h)} L {format(cur.l)} C {format(cur.c)}
      </div>
    </div>
  );
}

// Chart palette and type, from the site's CSS variables (BRAND.md): one accent, ink for text,
// rules for grids, up/down for change. Charts are SVG and inherit the page font.
"use client";
import { useEffect, useRef, useState } from "react";

export const chartTheme = {
  accent: "var(--accent)",
  accentInk: "var(--accent-ink)",
  ink: "var(--ink)",
  ink2: "var(--ink2)",
  ink3: "var(--ink3)",
  rule: "var(--rule)",
  rule2: "var(--rule2)",
  tint: "var(--tint)",
  up: "var(--up)",
  down: "var(--down)",
  mono: "var(--mono)",
  axisSize: 11,
  tweenMs: 420,
};

export type Fmt = (v: number) => string;
export const fmtNum: Fmt = (v) =>
  Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 });

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

// Tween a list of numbers toward `target` whenever it changes. New items start from the last
// shown value, so an appended point grows out of the line instead of jumping in.
// Bounded by design: nothing runs when the values did not move, a long series (a candle chart,
// a day of samples) or a hidden tab or reduced motion jumps straight to the target, and the
// frame loop always ends on the exact target. Each frame updates only this hook's component.
const MAX_TWEEN = 120;
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i] || (Number.isNaN(v) && Number.isNaN(b[i])));

export function useTween(target: number[], ms = chartTheme.tweenMs): number[] {
  const [shown, setShown] = useState<number[]>(target);
  const from = useRef<number[]>(target);
  const current = useRef<number[]>(target);
  const key = target.join(",");
  useEffect(() => {
    const start = current.current;
    if (same(start, target)) return;
    const jump =
      typeof window === "undefined" ||
      ms <= 0 ||
      target.length > MAX_TWEEN ||
      document.hidden ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (jump) {
      current.current = target;
      setShown(target);
      return;
    }
    const last = start.length ? start[start.length - 1] : target[0] ?? 0;
    from.current = target.map((_, i) => (i < start.length ? start[i] : last));
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - t0) / ms));
      const next = k >= 1 ? target : target.map((v, i) => from.current[i] + (v - from.current[i]) * k);
      current.current = next;
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted mid-tween: the next tween starts from where this one was.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  // Same length as the target on every render (the tween state lags one render when points are added).
  return target.map((t, i) => shown[i] ?? t);
}

// Width of the chart's box, so SVG coordinates are real pixels (crisp text, no stretching).
export function useWidth<T extends HTMLElement>(fallback = 600): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => setW(Math.max(120, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function extent(values: number[], pad = 0.08): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    const d = Math.abs(hi) * 0.02 || 1;
    lo -= d;
    hi += d;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

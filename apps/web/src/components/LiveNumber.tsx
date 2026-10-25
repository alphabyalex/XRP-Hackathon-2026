"use client";
// A number that eases to its new value when real data changes (no ticking on its own).
import { useTween } from "./charts";
import { fmt } from "@/lib/format";

export function LiveNumber({ value, digits = 2, suffix = "" }: { value: number; digits?: number; suffix?: string }) {
  const [v] = useTween([Number.isFinite(value) ? value : 0]);
  return (
    <span className="live-num">
      {fmt(v, digits)}
      {suffix}
    </span>
  );
}

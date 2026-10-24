"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { fmt } from "@/lib/format";

// Ported from the market table's flash-up/flash-dn classes in
// moonshift_v2_source.html. See BRAND.md "Price changes".
export function PriceFlash({ value, decimals = 3, className }: { value: number; decimals?: number; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<"up" | "dn" | null>(null);

  useEffect(() => {
    if (value !== prev.current) {
      setFlash(value >= prev.current ? "up" : "dn");
      prev.current = value;
      const t = setTimeout(() => setFlash(null), 1200);
      return () => clearTimeout(t);
    }
  }, [value]);

  return (
    <span className={clsx(className, flash === "up" && "flash-up", flash === "dn" && "flash-dn")}>
      {fmt(value, decimals)}
    </span>
  );
}

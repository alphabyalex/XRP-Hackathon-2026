"use client";
import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { useReveal } from "@/hooks/useReveal";

// Thin wrapper around useReveal for sections marked data-reveal in the
// reference (see .js [data-reveal] / .in in app/globals.css).
export function Reveal({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const { ref, inView } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} data-reveal className={clsx(inView && "in")} style={style}>
      {children}
    </div>
  );
}

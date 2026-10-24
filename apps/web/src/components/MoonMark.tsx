"use client";
import { useId } from "react";
import { rowsOf } from "@/lib/mark";

// Ported from drawMark() in moonshift_v2_source.html. See BRAND.md section 4.
export function MoonMark({ size = 28, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[:]/g, "");
  const rows = size <= 24 ? 5 : 8;
  const idA = `mk-a-${uid}`;
  const idB = `mk-b-${uid}`;

  return (
    <svg
      className={className}
      width={size}
      height={(size * 100) / 108}
      viewBox="0 0 108 100"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={idA}>
          <circle cx={50} cy={50} r={44} />
        </clipPath>
        <clipPath id={idB}>
          <circle cx={50} cy={50} r={44} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${idA})`}>
        {rowsOf(rows).map((r, i) => (
          <rect
            key={i}
            x={-20}
            y={r.y}
            width={Math.max(0, r.split - 1.6 + 20)}
            height={r.h}
            style={{ fill: "var(--mk-b)" }}
          />
        ))}
      </g>
      <g transform="translate(7 0)">
        <g clipPath={`url(#${idB})`}>
          {rowsOf(rows).map((r, i) => (
            <rect key={i} x={r.split + 1.6} y={r.y} width={140} height={r.h} style={{ fill: "var(--mk-f)" }} />
          ))}
        </g>
      </g>
    </svg>
  );
}

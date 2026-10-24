"use client";
import { useId } from "react";
import type { SlotState } from "@/lib/mark";
import { runs } from "@/lib/mark";

// Ported from moonAvatar() in moonshift_v2_source.html. 8 rows x 36 slots
// (last 24h, 5 min each), fed with a GPU's real schedule. See BRAND.md
// section 4 "GPU avatars (data moons)".
export function DataMoon({ slots, size = 40 }: { slots: SlotState[]; size?: number }) {
  const uid = useId().replace(/[:]/g, "");
  const rows = 8;
  const n = 36;
  const gap = 3.4;
  const h = (88 - 7 * gap) / 8;
  const u = 88 / n;
  const clipId = `av-${uid}`;

  const padded = slots.length >= rows * n ? slots.slice(0, rows * n) : [...slots, ...Array(rows * n - slots.length).fill("o" as SlotState)];

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={50} cy={50} r={44} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {Array.from({ length: rows }).map((_, k) => {
          const y = 6 + k * (h + gap);
          const rowSlots = padded.slice(k * n, (k + 1) * n);
          return runs(rowSlots).map(([s, len, t], j) => {
            const x = 6 + s * u + (s ? 0.7 : 0);
            const w = Math.max(0, len * u - (s ? 0.7 : 0) - (s + len < n ? 0.7 : 0));
            return <rect key={`${k}-${j}`} x={x} y={y} width={w} height={h} className={`s${t}`} />;
          });
        })}
      </g>
    </svg>
  );
}

import type { SlotState } from "@/lib/mark";
import { rowSegments } from "@/lib/mark";

// Ported from the market table's .mini sparkline (2 rows of 12h = 144 slots
// each) in moonshift_v2_source.html.
export function MiniSchedule({ slots }: { slots: SlotState[] }) {
  const perRow = 144;
  const rows = [slots.slice(0, perRow), slots.slice(perRow, perRow * 2)];
  return (
    <div className="mini">
      {rows.map((row, k) => {
        const segs = rowSegments(row, 0.5);
        return (
          <svg key={k} viewBox={`0 0 ${perRow} 8`} preserveAspectRatio="none" aria-hidden="true">
            {segs.map((s, j) =>
              s.open ? (
                <rect key={j} x={s.x} y={0.5} width={s.w} height={7} rx={0.6} className="so" />
              ) : (
                <rect key={j} x={s.x} y={0} width={s.w} height={8} className={`s${s.state}`} />
              )
            )}
          </svg>
        );
      })}
    </div>
  );
}

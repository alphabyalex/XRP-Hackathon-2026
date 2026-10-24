"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import type { SlotState } from "@/lib/mark";
import { rowSegments } from "@/lib/mark";
import { hm, timeAt, SLOT_LABEL } from "@/lib/schedule";
import { fmt } from "@/lib/format";
import { useReveal } from "@/hooks/useReveal";

// Ported from the "sched" block (rowSVG + sched() + the tooltip listeners)
// in moonshift_v2_source.html. See BRAND.md section 5.

const EARN: Record<SlotState, number> = { b: 0.045, l: 0.025, i: 0, o: 0 };

export function ScheduleRows({
  slots,
  rows = 8,
  nowIndex,
  windowStart,
  showTimes = true,
  animate = true,
}: {
  slots: SlotState[];
  rows?: number;
  nowIndex: number;
  windowStart: Date;
  showTimes?: boolean;
  animate?: boolean;
}) {
  const uid = useId().replace(/[:]/g, "");
  const cols = Math.floor(slots.length / rows);
  const { ref, inView } = useReveal<HTMLDivElement>();
  const in_ = animate ? inView : true;
  const [tip, setTip] = useState<{ x: number; y: number; label: string } | null>(null);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const bar = (e.target as HTMLElement).closest<HTMLElement>(".bar");
    if (!bar || !ref.current) {
      setTip(null);
      return;
    }
    const r = bar.getBoundingClientRect();
    const k = Number(bar.dataset.row);
    const col = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols)));
    const i = k * cols + col;
    const st = slots[i];
    if (!st) {
      setTip(null);
      return;
    }
    const label = SLOT_LABEL[st];
    const earn = EARN[st];
    const pr = ref.current.getBoundingClientRect();
    setTip({
      x: e.clientX - pr.left,
      y: r.top - pr.top,
      label: `${hm(timeAt(windowStart, i))} to ${hm(timeAt(windowStart, i + 1))} · ${label}${earn ? ` +${fmt(earn, 3)} USDC` : ""}`,
    });
  }

  return (
    <div className={clsx("sched", in_ && "in")} ref={ref} onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {Array.from({ length: rows }).map((_, k) => {
        const rowSlots = slots.slice(k * cols, (k + 1) * cols);
        const segs = rowSegments(rowSlots, 0.09);
        const nowInRow = nowIndex >= k * cols && nowIndex < (k + 1) * cols;
        const nowLeft = nowInRow ? ((nowIndex - k * cols) / cols) * 100 : 0;
        return (
          <div className="srow" key={k} style={{ transitionDelay: `${k * 70}ms` }}>
            {showTimes && <span className="t">{hm(timeAt(windowStart, k * cols))}</span>}
            <div className="bar" data-row={k}>
              <svg viewBox={`0 0 ${cols} 22`} preserveAspectRatio="none" aria-hidden="true">
                <g style={{ transitionDelay: `${k * 70}ms` }}>
                  {segs.map((s, j) =>
                    s.open ? (
                      <rect key={j} x={s.x} y={0.5} width={s.w} height={21} rx={0.6} className="so" />
                    ) : (
                      <rect key={j} x={s.x} y={0} width={s.w} height={22} className={`s${s.state}`} />
                    )
                  )}
                </g>
              </svg>
              {nowInRow && (
                <span className="nowline" style={{ left: `${nowLeft}%` }}>
                  <span>NOW</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div className={clsx("tip", tip && "on")} style={tip ? { left: tip.x, top: tip.y } : undefined}>
        {tip?.label}
      </div>
    </div>
  );
}

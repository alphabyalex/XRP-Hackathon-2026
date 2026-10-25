// Mark geometry, shared by MoonMark, DataMoon, ScheduleRows and Hero3DMark.
// Ported from drawMark/rowsOf/runs/rowSVG in moonshift_v2_source.html.
// See BRAND.md section 4 for the math this implements.

export type SlotState = "b" | "l" | "i" | "o"; // working (b and l draw the same), idle, open

export const MK = { R: 44, cx: 50, cy: 50, inR: 38, inCx: 40, off: 7 } as const;

export interface MarkRow {
  y: number;
  h: number;
  split: number;
}

export function rowsOf(n: number): MarkRow[] {
  const gap = n > 6 ? 3.4 : 7;
  const h = (2 * MK.R - (n - 1) * gap) / n;
  const out: MarkRow[] = [];
  for (let i = 0; i < n; i++) {
    const y = MK.cy - MK.R + i * (h + gap);
    const yc = y + h / 2;
    const inner = Math.sqrt(Math.max(0, MK.inR ** 2 - (yc - MK.cy) ** 2));
    const outer = Math.sqrt(Math.max(0, MK.R ** 2 - (yc - MK.cy) ** 2));
    out.push({ y, h, split: Math.min(MK.cx + outer, MK.inCx + inner) });
  }
  return out;
}

// Groups a flat slot-state array into contiguous runs: [start, length, state][]
export function runs(states: SlotState[]): [number, number, SlotState][] {
  const out: [number, number, SlotState][] = [];
  let s = 0;
  for (let i = 1; i <= states.length; i++) {
    if (i === states.length || states[i] !== states[s]) {
      out.push([s, i - s, states[s]]);
      s = i;
    }
  }
  return out;
}

export interface RowSegment {
  x: number;
  w: number;
  state: SlotState;
  open: boolean;
}

// One row of segments for an SVG bar, gapU in the same units as the slot
// index (fraction of a slot width to leave as a gap between differing runs).
export function rowSegments(states: SlotState[], gapU: number): RowSegment[] {
  const n = states.length;
  const segs: RowSegment[] = [];
  for (const [s, len, k] of runs(states)) {
    const x = s + (s ? gapU : 0);
    const w = Math.max(0, len - (s ? gapU : 0) - (s + len < n ? gapU : 0));
    segs.push({ x, w, state: k, open: k === "o" });
  }
  return segs;
}

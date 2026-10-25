// Turns apps/api calendar entries into a flat array of slot states for
// ScheduleRows / MiniSchedule / DataMoon. See CLAUDE_NOTES_3_FRONTEND.md
// section 4 "Schedule" for the mapping rules.

import type { SlotState } from "./mark";

export interface CalendarEntryLike {
  start: string;
  end: string;
  kind: string; // "BOOKED" | "CONTRACT" | "INFERENCE" | anything else
}

const SLOT_MS = 5 * 60 * 1000;

export interface BuiltSchedule {
  slots: SlotState[];
  nowIndex: number;
  windowStart: Date;
}

// One activity state: any work (a task, a booking, inference) is "working".
function kindToState(kind: string): SlotState | null {
  if (kind === "BOOKED" || kind === "CONTRACT" || kind === "INFERENCE") return "l";
  return null;
}

// Default window matches the reference copy: "last 20 hours and next 4".
export function buildSchedule(
  entries: CalendarEntryLike[],
  now: Date = new Date(),
  pastHours = 20,
  futureHours = 4
): BuiltSchedule {
  // Start on a whole hour so row labels read 16:00, 19:00 and slots sit on
  // 5 minute boundaries (12:25, 12:30) instead of drifting with the clock.
  const hourStart = Math.floor(now.getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000;
  const windowStart = new Date(hourStart - (pastHours - 1) * 60 * 60 * 1000);
  const slotCount = ((pastHours + futureHours) * 60) / 5;
  const nowIndex = Math.floor((now.getTime() - windowStart.getTime()) / SLOT_MS);

  const parsed = entries
    .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime(), state: kindToState(e.kind) }))
    .filter((e) => e.state !== null) as { start: number; end: number; state: SlotState }[];

  const slots: SlotState[] = [];
  for (let i = 0; i < slotCount; i++) {
    const slotStart = windowStart.getTime() + i * SLOT_MS;
    const slotEnd = slotStart + SLOT_MS;
    const hit = parsed.find((e) => e.start < slotEnd && e.end > slotStart);
    if (hit) {
      slots.push(hit.state);
    } else {
      slots.push(slotEnd <= now.getTime() ? "i" : "o");
    }
  }

  return { slots, nowIndex, windowStart };
}

// Share of the schedule's past slots that were working (what the bars show).
export function utilizationOf(slots: SlotState[], nowIndex: number): number {
  const past = slots.slice(0, Math.max(0, nowIndex));
  return past.length ? (past.filter((s) => s === "b" || s === "l").length / past.length) * 100 : 0;
}

export function timeAt(windowStart: Date, index: number): Date {
  return new Date(windowStart.getTime() + index * SLOT_MS);
}

export function hm(d: Date): string {
  // The same timestamp must render identically on the server and in every browser timezone.
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

export const SLOT_LABEL: Record<SlotState, string> = {
  b: "Working",
  l: "Working",
  i: "Idle",
  o: "Open to book",
};

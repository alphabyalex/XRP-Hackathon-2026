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

function kindToState(kind: string): SlotState | null {
  if (kind === "BOOKED" || kind === "CONTRACT") return "b";
  if (kind === "INFERENCE") return "l";
  return null;
}

// Default window matches the reference copy: "last 20 hours and next 4".
export function buildSchedule(
  entries: CalendarEntryLike[],
  now: Date = new Date(),
  pastHours = 20,
  futureHours = 4
): BuiltSchedule {
  const windowStart = new Date(now.getTime() - pastHours * 60 * 60 * 1000);
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

export function timeAt(windowStart: Date, index: number): Date {
  return new Date(windowStart.getTime() + index * SLOT_MS);
}

export function hm(d: Date): string {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export const SLOT_LABEL: Record<SlotState, string> = {
  b: "Booked",
  l: "Night shift",
  i: "Idle",
  o: "Open to book",
};

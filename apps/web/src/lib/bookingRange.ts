import type { CalendarBlock } from "./catalog";
const HOUR_MS = 3600000;
export function freeHour(block: CalendarBlock, now: number): boolean {
  const start = Date.parse(block.start), end = Date.parse(block.end);
  return start > now && end - start === HOUR_MS && block.runningMinutes === 0 && block.bookedMinutes === 0 && block.status === "free";
}
export function contiguousHours(blocks: CalendarBlock[], anchor: string, focus: string, now: number): CalendarBlock[] {
  const first = blocks.findIndex(block => block.start === anchor), last = blocks.findIndex(block => block.start === focus);
  if (first < 0 || last < 0 || Math.abs(first - last) >= 24) return [];
  const range = blocks.slice(Math.min(first, last), Math.max(first, last) + 1);
  if (range.some((block, index) => !freeHour(block, now) || (index > 0 && Date.parse(range[index - 1].end) !== Date.parse(block.start)))) return [];
  return range;
}

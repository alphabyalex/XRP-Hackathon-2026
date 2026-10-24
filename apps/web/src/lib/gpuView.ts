import type { ApiGpuDetail } from "@moonshift/shared";
import { buildSchedule } from "./schedule";
import { splitRevenue } from "./economics";

// Normalizes an ApiGpuDetail into the pieces every GPU-facing component
// needs: a 24h (20 past + 4 future) slot array, the NOW index, and the
// revenue split. Built fresh each render from live data, not memoized,
// since "now" and the live revenue figure both change.
export function gpuView(gpu: ApiGpuDetail, now: Date = new Date()) {
  const { slots, nowIndex, windowStart } = buildSchedule(gpu.calendar, now);
  const revenue24h = Number(gpu.revenue24h) || 0;
  const split = splitRevenue(revenue24h);
  const dashLabel = gpu.id.toUpperCase(); // "gpu-a" -> "GPU-A"
  return { gpu, slots, nowIndex, windowStart, revenue24h, split, dashLabel };
}

export type GpuView = ReturnType<typeof gpuView>;

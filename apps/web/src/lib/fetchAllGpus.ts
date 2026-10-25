import { getGpu, getGpus } from "./api";
import type { GpuMap } from "./liveData";

export async function fetchAllGpus(): Promise<{ gpus: GpuMap; unreachable: boolean }> {
  try {
    const listed = await getGpus();
    const results = await Promise.allSettled(listed.map((gpu) => getGpu(gpu.id)));
    const entries = results.flatMap(result => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []);
    return { gpus: Object.fromEntries(entries), unreachable: listed.length > 0 && entries.length === 0 };
  } catch {
    return { gpus: {}, unreachable: true };
  }
}

import { getGpu, getGpus, ApiUnreachableError } from "./api";
import type { GpuMap } from "./liveData";

export async function fetchAllGpus(): Promise<{ gpus: GpuMap; unreachable: boolean }> {
  try {
    // The listed GPUs only (endpoint healthy, or the mock GPU); the registry keeps the rest hidden.
    const listed = await getGpus();
    const entries = await Promise.all(listed.map((g) => getGpu(g.id)));
    return { gpus: Object.fromEntries(entries.map((e) => [e.id, e])), unreachable: false };
  } catch (_err) {
    return { gpus: {}, unreachable: true };
  }
}

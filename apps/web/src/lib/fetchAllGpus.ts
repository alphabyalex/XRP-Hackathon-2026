import { GPUS } from "@moonshift/shared";
import { getGpu, ApiUnreachableError } from "./api";
import type { GpuMap } from "./liveData";

export async function fetchAllGpus(): Promise<{ gpus: GpuMap; unreachable: boolean }> {
  try {
    const entries = await Promise.all(GPUS.map((g) => getGpu(g.id)));
    return { gpus: Object.fromEntries(entries.map((e) => [e.id, e])), unreachable: false };
  } catch (err) {
    if (err instanceof ApiUnreachableError) return { gpus: {}, unreachable: true };
    throw err;
  }
}

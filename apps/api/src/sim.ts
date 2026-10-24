// Load simulator for the demo: periodically fires a fake chat completion so
// the revenue ticker moves without a human typing in the Playground.

import * as compute from "./adapters/computeClient.js";
import { recordUsage } from "./db/helpers.js";
import { broadcast } from "./sse.js";

let timer: NodeJS.Timeout | null = null;

export function isSimRunning(): boolean {
  return timer !== null;
}

export function startSim(): void {
  if (timer) return;
  timer = setInterval(async () => {
    const startedAt = new Date().toISOString();
    try {
      const result = await compute.chatCompletions(
        { messages: [{ role: "user", content: "simulated load ping" }] },
        "SIM",
        undefined
      );
      const finishedAt = new Date().toISOString();
      recordUsage({
        request_id: result.x_ms.request_id,
        gpu_id: result.x_ms.gpu_id,
        buyer: "SIM",
        booking_id: null,
        input_tokens: result.x_ms.input_tokens,
        output_tokens: result.x_ms.output_tokens,
        charge: result.x_ms.charge,
        started_at: startedAt,
        finished_at: finishedAt,
        simulated: true,
      });
      broadcast("usage", { ...result.x_ms, simulated: true });
    } catch {
      // booked or otherwise rejected, just skip this tick
    }
  }, 4000);
}

export function stopSim(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

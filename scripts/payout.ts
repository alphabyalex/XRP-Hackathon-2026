// npx tsx scripts/payout.ts gpu-a (with PRICING_URL, COMPUTE_URL and MOCK_XRPL=0 as the stack sets them): pay one GPU's metered, not yet paid revenue to its holders now, the same
// way the nightly run does (pricing proposes the split, the treasury pays each holder on devnet).
// Prints run ids, amounts and tx hashes only.
import "../apps/api/src/env.js";
import type { GpuId } from "@moonshift/shared";

async function main() {
const { proposeDividendRun, approveDividendRun } = await import("../apps/api/src/dividends.js");
for (const gpuId of (process.argv.slice(2).length ? process.argv.slice(2) : ["gpu-a"]) as GpuId[]) {
  const run = (await proposeDividendRun(gpuId)) as Record<string, any>;
  console.log(`${gpuId}: proposed ${run.id}, gross ${run.gross_revenue ?? run.grossRevenue}, to holders ${run.distributable}, per share ${run.per_share ?? run.perShare}`);
  if (!(Number(run.distributable) > 0)) {
    console.log(`${gpuId}: nothing to pay`);
    continue;
  }
  const paid = await approveDividendRun(run.id);
  console.log(`${gpuId}: ${paid.status}, ${paid.txs.length} payments, first ${paid.txs[0] ?? "-"}`);
}
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  }
);

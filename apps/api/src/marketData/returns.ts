import { GPUS, fix6, type AccountReturnsResponse } from "@moonshift/shared";

export interface DividendReceipt { gpuId: string; amount: string; time: string }

// Received dividends are a cash return. An investment ROI percentage requires
// cost basis, which the account's historical trade log does not yet contain.
export function buildReturns(account: string, days: number, receipts: DividendReceipt[], now = new Date()): AccountReturnsResponse {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const from = start.toISOString();
  const to = now.toISOString();
  const series = GPUS.map(gpu => {
    const byDay = new Map<string, number>();
    for (const receipt of receipts) {
      if (receipt.gpuId !== gpu.id || receipt.time < from || receipt.time > to) continue;
      const day = receipt.time.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + Number(receipt.amount));
    }
    let cumulative = 0;
    const points = Array.from({ length: days }, (_, i) => {
      const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
      const earned = byDay.get(date) ?? 0;
      cumulative += earned;
      return { date, earned: fix6(earned), cumulative: fix6(cumulative) };
    });
    return {
      gpuId: gpu.id, label: gpu.label, hardware: gpu.hw.replace(/\s*\(simulated[^)]*\)/gi, ""),
      totalEarned: fix6(cumulative), days: points,
    };
  });
  return { account, days, from, to, currency: "USDC", totalEarned: fix6(series.reduce((sum, s) => sum + Number(s.totalEarned), 0)), series };
}

// MOCK: replace when /gpus/:id/history exists (see docs/CONTRACTS.md
// "Requests from apps/web"). apps/api has no price-history endpoint, so
// this generates a deterministic (seeded by gpuId) hourly random walk that
// ends exactly at the GPU's real current share price, used for the 7 day
// chart and the 24h change % shown in the market table and GPU header.

function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export interface PricePoint {
  t: number;
  price: number;
}

export function mockPriceHistory(gpuId: string, currentPrice: number, points = 168): PricePoint[] {
  const seed = [...gpuId].reduce((s, c) => s + c.charCodeAt(0), 0) * 7919 + 1;
  const r = rng(seed);
  const prices = [currentPrice || 1];
  for (let i = 1; i < points; i++) {
    const drift = (r() - 0.5) * 0.006;
    prices.push(prices[i - 1] / (1 + drift));
  }
  prices.reverse();
  const now = Date.now();
  const hourMs = 3_600_000;
  return prices.map((price, i) => ({ t: now - (points - 1 - i) * hourMs, price }));
}

export function change24h(history: PricePoint[]): number {
  if (history.length < 25) return 0;
  const now = history[history.length - 1].price;
  const prev = history[history.length - 25].price;
  return prev ? (now / prev - 1) * 100 : 0;
}

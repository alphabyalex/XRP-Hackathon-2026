export interface GpuStats {
  gpuId: string;
  asOf: string;
  price: string;
  change24hPct: string;
  navPerShare: string | null;
  revenue24h: string;
  paidPerShare24h: string;
  yieldPct: string;
  workingPct20h: string;
  paidToHoldersLastNight: string;
  openingPrice: string;
  openedAt: string;
}

export interface MarketLevel { price: string; size: string; total: string }
export interface MarketTrade { id: string; time: string; side: "buy" | "sell"; size: string; price: string; txHash: string }
export interface MarketCandle { time: string; open: string; high: string; low: string; close: string; volume: string }
export interface MarketEvent { gpuId: string; asOf: string; price: string; bookChanged: boolean; trades: MarketTrade[] }
export interface LendingMarketMetadata {
  title: string; useOfFunds: string; gpuCount: number; powerKw: number | null;
  unitPrice: string | null; gpuId: string; location: string | null; targetApr: string | null;
}

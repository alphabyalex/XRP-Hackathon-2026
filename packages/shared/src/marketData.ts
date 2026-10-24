export interface ReturnSeries {
  gpuId: string;
  label: string;
  hardware: string;
  totalEarned: string;
  days: { date: string; earned: string; cumulative: string }[];
}

export interface AccountReturnsResponse {
  account: string;
  days: number;
  from: string;
  to: string;
  currency: "USDC";
  totalEarned: string;
  series: ReturnSeries[];
}

export interface GpuMarketPrice {
  id: string;
  name: string;
  vramGb: number;
  rentalUsdPerHour: string | null;
  providers: number;
  sourceUrl: string;
  weeklyHistory: { date: string; price: string; providers: number }[];
  observations: { time: string; rentalUsdPerHour: string | null }[];
}

export interface GpuMarketPricesResponse {
  source: { name: string; url: string; license: string };
  sourceUpdatedAt: string;
  checkedAt: string;
  refreshSeconds: number;
  stale: boolean;
  historyStale: boolean;
  gpus: GpuMarketPrice[];
}

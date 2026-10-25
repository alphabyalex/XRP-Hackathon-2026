export interface AccountHolding {
  slots?: ("b" | "l" | "i" | "o")[];
  telemetry?: { calendarAvailable: boolean; revenueAvailable: boolean };
  gpuId: string; label: string; hardware: string; free: string; locked: string;
  shares: string; sharePrice: string | null; value: string | null; change24h: string | null;
  yield: string | null; earned7d: string; ownershipPct: string;
}
export interface AccountPerformance {
  gpuId: string;
  days: { date: string; revenue?: string; booked: string | null; inference: string | null; utilization: string | null }[];
  revenue24h: string | null; utilization24h: string | null;
  revenueAvailable?: boolean; source?: "usage_meter" | "unavailable";
}
export interface AccountLoan {
  id: string; gpuId: string; outstanding: string; collateralShares: string;
  collateralValue: string; ltv: string; marginCallLtv: string; liquidationLtv: string;
  priceDropToMarginCall: string; nextPayment: { amount: string; dueAt: string | null };
  status: "healthy" | "watch" | "margin call"; txs: Record<string, string>; explorerUrl: string | null;
}
export interface AccountActivity {
  id: string; time: string; type: string; amount: string | null; unit: string;
  direction: "in" | "out" | "neutral"; txHash: string | null; explorerUrl: string | null;
}
export interface AccountResponse {
  account: string; address: string; explorerUrl: string | null; updatedAt: string;
  balances: { usdc: string; xrp: string; shares: { gpuId: string; free: string; locked: string }[] };
  holdings: AccountHolding[]; gpuPerformance: AccountPerformance[]; loans: AccountLoan[];
  activity: AccountActivity[]; totals: { totalValue: string | null; earned7d: string; earned30d: string };
}

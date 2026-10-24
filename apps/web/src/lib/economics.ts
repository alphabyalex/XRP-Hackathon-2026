// 80/15/5 revenue split (holders/hosting/reserve) per BRAND.md section 9 and
// CLAUDE_NOTES_3_FRONTEND.md section 4 "Money section". Uses the same bps
// constants as apps/api's pricing adapter mock.

import { HOSTING_FEE_BPS, RESERVE_BPS } from "@moonshift/shared";

export interface RevenueSplit {
  gross: number;
  hosting: number;
  reserve: number;
  holders: number;
}

export function splitRevenue(gross: number): RevenueSplit {
  const hosting = gross * (HOSTING_FEE_BPS / 10000);
  const afterFee = gross - hosting;
  const reserve = afterFee * (RESERVE_BPS / 10000);
  const holders = afterFee - reserve;
  return { gross, hosting, reserve, holders };
}

export function perSharePerNight(revenue24h: number, sharesTotal = 1000): number {
  return splitRevenue(revenue24h).holders / sharesTotal;
}

// MOCK: apps/api has no pre-trade contract-price quote endpoint yet
// (buyContracts returns only a TxResult, no amount). Requested in
// docs/CONTRACTS.md. Falls back to a flat placeholder if revenue is 0.
export function mockSlotPrice(revenue24h: number): number {
  const derived = revenue24h / 288;
  return derived > 0 ? derived : 0.045;
}

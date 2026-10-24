// XLS-65 vault and XLS-66 loan shapes shared by packages/xrpl, apps/api and
// apps/web. Amounts are TDX DecimalStrings (6 decimals). Rates on the ledger
// are 1/10 basis points; here they are converted to plain percentages.

import type { DecimalString, IsoDateTime } from "./types";

// A closed-ended vault moves through three phases. Deposits only in
// subscription, loans only in investment, withdrawals in subscription or
// redemption.
export type VaultPhase = "subscription" | "investment" | "redemption";

// One lending round = one closed-ended vault + its loan broker. Public IDs
// only, persisted in contracts/lending.<network>.json.
export interface LendingRound {
  round: number;
  vaultId: string;
  loanBrokerId: string;
  vaultAccount: string; // vault pseudo-account
  brokerAccount: string; // loan broker pseudo-account
  shareMptId: string; // vault share token (MPT)
  subscriptionDate: IsoDateTime;
  redemptionDate: IsoDateTime;
  createdTx: string;
}

export interface LendingStateFile {
  network: string;
  broker: string; // Moonshift broker (vault owner) address, the LENDING_POOL account
  rounds: LendingRound[];
}

export interface VaultState {
  round: number;
  vaultId: string;
  loanBrokerId: string;
  phase: VaultPhase;
  asset: "TDX";
  assetsTotal: DecimalString;
  assetsAvailable: DecimalString;
  lossUnrealized: DecimalString;
  debtTotal: DecimalString; // owed to the vault by open loans
  coverAvailable: DecimalString; // broker first-loss capital
  utilizationPct: string; // debtTotal / assetsTotal
  sharesOutstanding: DecimalString;
  sharePrice: DecimalString; // TDX per vault share
  lenderApyPct: string; // estimate: weighted loan APR x (1 - management fee) x utilization
  subscriptionDate: IsoDateTime;
  redemptionDate: IsoDateTime;
  explorerUrl: string; // vault pseudo-account on the explorer
}

export interface LoanBrokerState {
  loanBrokerId: string;
  vaultId: string;
  owner: string;
  account: string; // pseudo-account
  debtTotal: DecimalString;
  debtMaximum: DecimalString; // "0" = no limit
  coverAvailable: DecimalString;
  coverRateMinimumPct: string;
  coverRateLiquidationPct: string;
  managementFeePct: string;
  loansOriginated: number;
}

// Ledger rate units (1/10 basis point) <-> percent.
export const TENTH_BPS_PER_PCT = 1000;
export function pctToTenthBps(pct: number): number {
  return Math.round(pct * TENTH_BPS_PER_PCT);
}
export function tenthBpsToPct(v: number | undefined): string {
  return ((v ?? 0) / TENTH_BPS_PER_PCT).toFixed(3);
}

// Ripple epoch (seconds since 2000-01-01) <-> ISO.
export const RIPPLE_EPOCH_OFFSET = 946684800;
export function rippleToIso(t: number): IsoDateTime {
  return new Date((t + RIPPLE_EPOCH_OFFSET) * 1000).toISOString();
}
export function isoToRipple(iso: IsoDateTime | Date): number {
  return Math.floor(new Date(iso).getTime() / 1000) - RIPPLE_EPOCH_OFFSET;
}

export function vaultPhase(subscriptionDate: IsoDateTime, redemptionDate: IsoDateTime, now = new Date()): VaultPhase {
  const t = now.getTime();
  if (t < new Date(subscriptionDate).getTime()) return "subscription";
  if (t < new Date(redemptionDate).getTime()) return "investment";
  return "redemption";
}

// Ledger Number fields can carry more digits than an IOU amount allows (15
// significant). Round UP to 6 decimals so a payment never falls short.
export function ceil6(v: string | number): DecimalString {
  const s = /e/i.test(String(v)) ? Number(v).toFixed(18) : String(v);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const head = BigInt((i || "0") + (f + "000000").slice(0, 6));
  const bump = !neg && /[1-9]/.test(f.slice(6)) ? 1n : 0n;
  const n = (head + bump).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${n.slice(0, -6)}.${n.slice(-6)}`;
}

// Round to 6 decimals for display and IOU amounts that need not round up.
export function fix6(v: string | number | undefined): DecimalString {
  const n = Number(v ?? 0);
  return (Number.isFinite(n) ? n : 0).toFixed(6);
}

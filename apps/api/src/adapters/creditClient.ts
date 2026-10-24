// Adapter over services/credit (Lucy, port 7100). MOCK_CREDIT=1 (default)
// returns a profile in exactly the contracts/credit/profile.json shape,
// labeled simulated. MOCK_CREDIT=0 calls CREDIT_URL and falls back to the
// mock (source "mock-fallback") if the service is unreachable.

import { createHash } from "crypto";
import type { CreditFeature, CreditProfile, CreditStats, DataSource, RiskCreditProfile } from "@moonshift/shared";
import { mockFlag } from "../env.js";
import { serviceJson, noteSource, ServiceUnavailable } from "./serviceFetch.js";
import { db } from "../db/db.js";
import { swr } from "../lending/swr.js";

const CREDIT_URL = () => process.env.CREDIT_URL ?? "http://localhost:7100";

// Risk wants confidence as a number (director note, 12:58).
const CONFIDENCE_NUM: Record<string, number> = { low: 0.3, medium: 0.6, high: 0.9 };

function gradeFor(score: number): CreditProfile["grade"] {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "E";
}

// Real tx hashes we already logged for this account (devnet or testnet), so
// the "top factors" links in the UI open real transactions even in mock mode.
function knownHashes(accountName: string | undefined, limit = 6): string[] {
  if (!accountName) return [];
  try {
    const rows = db
      .prepare(`SELECT hash FROM tx_log WHERE account = ? AND hash NOT LIKE 'MOCK%' ORDER BY created_at DESC LIMIT ?`)
      .all(accountName, limit) as { hash: string }[];
    return rows.map((r) => r.hash);
  } catch {
    return [];
  }
}

export function mockProfile(network: string, address: string, accountName?: string): CreditProfile {
  const h = createHash("sha256").update(address).digest();
  const score = 62 + (h[0] % 24); // 62..85, stable per address
  const hashes = knownHashes(accountName);
  const pick = (i: number) => (hashes[i] ? [hashes[i]] : []);
  const f = (value: number | string, points: number, reason: string, txHashes: string[] = []): CreditFeature => ({
    value,
    points,
    reason,
    txHashes,
  });
  const ageDays = 200 + (h[1] % 1200);
  const txCount = 40 + (h[2] % 600);
  const features: Record<string, CreditFeature> = {
    accountAgeDays: f(ageDays, ageDays > 1095 ? 10 : ageDays > 365 ? 6 : 2, ageDays > 1095 ? "ACCOUNT_AGE_3Y_PLUS" : ageDays > 365 ? "ACCOUNT_AGE_1Y_PLUS" : "ACCOUNT_AGE_UNDER_1Y", pick(0)),
    txCount: f(txCount, txCount >= 200 ? 5 : 2, txCount >= 200 ? "TX_COUNT_200_PLUS" : "TX_COUNT_40_PLUS"),
    paymentVolumeInXrp: f((1000 + h[3] * 40).toFixed(6), 3, "VOLUME_IN_1K_PLUS", pick(1)),
    paymentVolumeOutXrp: f((800 + h[4] * 35).toFixed(6), 2, "VOLUME_OUT_1K_PLUS", pick(2)),
    distinctCounterparties: f(5 + (h[5] % 30), 3, "COUNTERPARTIES_10_PLUS"),
    trustlines: f(2 + (h[6] % 4), 2, "TRUSTLINES_1_PLUS"),
    balanceStability: f(Number((0.4 + (h[7] % 50) / 100).toFixed(2)), 3, "BALANCE_STABLE"),
    largestOutflowRatio: f(Number((0.2 + (h[8] % 50) / 100).toFixed(2)), h[8] % 50 > 30 ? -4 : 0, h[8] % 50 > 30 ? "LARGE_OUTFLOW_50PCT" : "NO_LARGE_OUTFLOW", pick(3)),
    msRepaysOnTime: f(0, 0, "NO_MS_REPAYS"),
    msRepaysLate: f(0, 0, "NO_LATE_REPAYS"),
    msMarginCalls: f(0, 0, "NO_MARGIN_CALLS"),
    msLiquidations: f(0, 0, "NO_LIQUIDATIONS"),
  };
  const reasons = Object.values(features)
    .filter((x) => x.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .map((x) => x.reason);
  const grade = gradeFor(score);
  return {
    address,
    network,
    readOnly: network === "mainnet",
    source: "mock",
    simulated: true,
    score,
    grade,
    confidence: score >= 75 ? "high" : "medium",
    features,
    reasons,
    portfolio: {
      grade,
      defaultRatePct: ({ A: "0.8", B: "2.4", C: "6.1", D: "14.0", E: "31.5" } as const)[grade],
      loans: 180,
      text: `borrowers in this grade defaulted ${({ A: "0.8", B: "2.4", C: "6.1", D: "14.0", E: "31.5" } as const)[grade]}% (model estimate)`,
      simulated: true,
    },
    asOf: new Date().toISOString(),
  };
}

// The combined profile reads devnet and linked mainnet history. Served from
// cache: refreshed in the background at most every 60 s, kept up to 30 min so
// a borrower's page never waits on a full history read. Fallbacks are not kept.
const profileCache = swr<{ profile: CreditProfile; source: DataSource }>("credit-profile", 60_000, 30 * 60_000, (r) => r.source === "live");

export function getProfile(network: string, address: string, accountName?: string): Promise<{ profile: CreditProfile; source: DataSource }> {
  if (mockFlag("MOCK_CREDIT")) return readProfile(network, address, accountName);
  return profileCache.get(`${network}:${address}`, () => readProfile(network, address, accountName));
}

// A loan event changes the borrower's Moonshift history: read it fresh next time.
export function invalidateProfile(network: string, address: string): void {
  profileCache.invalidate(`${network}:${address}`);
}

async function readProfile(network: string, address: string, accountName?: string): Promise<{ profile: CreditProfile; source: DataSource }> {
  if (mockFlag("MOCK_CREDIT")) {
    noteSource("credit", "mock");
    return { profile: mockProfile(network, address, accountName), source: "mock" };
  }
  try {
    const profile = await serviceJson<CreditProfile>("credit", `${CREDIT_URL()}/profile/${network}/${address}`);
    noteSource("credit", "live");
    return { profile, source: "live" };
  } catch (e) {
    if (!(e instanceof ServiceUnavailable)) throw e;
    noteSource("credit", "mock-fallback");
    return { profile: { ...mockProfile(network, address, accountName), source: "mock-fallback" }, source: "mock-fallback" };
  }
}

// Quicknode usage counters from the credit service (no URLs). Mock: zeros, simulated.
export async function getStats(): Promise<CreditStats> {
  const empty: CreditStats = {
    since: new Date().toISOString(),
    quicknode: { calls: 0, creditsUsed: 0, creditsPerCall: 40, p50LatencyMs: null, cacheHitRate: 0, byNetwork: {}, byMethod: {} },
    totals: { upstreamCalls: 0, cacheHits: 0, cacheHitRate: 0 },
    simulated: true,
  };
  if (mockFlag("MOCK_CREDIT")) return { ...empty, dataSource: "mock" };
  try {
    return { ...(await serviceJson<CreditStats>("credit", `${CREDIT_URL()}/stats`, { timeoutMs: 3000 })), dataSource: "live" };
  } catch {
    return { ...empty, dataSource: "mock-fallback" };
  }
}

// Ask credit to watch a borrower live (MISSED_PAYMENT detection). Best effort.
export async function watch(network: string, address: string, loans: { loanId: string; dueAt: string; principal: string }[]): Promise<void> {
  if (mockFlag("MOCK_CREDIT")) return;
  try {
    await serviceJson("credit", `${CREDIT_URL()}/watch`, { body: { network, address, loans }, timeoutMs: 4000 });
  } catch {
    // credit down; the loan still works
  }
}

// Lucy's profile -> the creditProfile block risk's /quote expects.
export function toRiskProfile(p: CreditProfile): RiskCreditProfile {
  const evidence: { feature: string; txHash: string }[] = [];
  const features: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.features ?? {})) {
    features[k] = v?.value;
    for (const txHash of v?.txHashes ?? []) evidence.push({ feature: k, txHash });
  }
  const repays = Number(p.features?.msRepaysOnTime?.value ?? 0);
  features.repaymentCount = repays;
  return {
    address: p.address,
    network: p.network,
    score: p.score,
    grade: p.grade,
    confidence: CONFIDENCE_NUM[p.confidence] ?? 0.6,
    features,
    evidence,
    reasons: p.reasons ?? [],
  };
}

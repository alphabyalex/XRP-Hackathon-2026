// Lending (XLS-65 vault + XLS-66 loans) for apps/api. MOCK_XRPL=0 calls
// packages/xrpl on the active NETWORK (devnet for lending). MOCK_XRPL=1 keeps
// an in-memory vault and loan book with the same shapes, labeled simulated,
// so the web app works with no network at all.

import { randomBytes } from "crypto";
import * as realXrpl from "@moonshift/xrpl";
import {
  ceil6,
  explorerUrl,
  fix6,
  networkInfo,
  rippleToIso,
  type AccountName,
  type GpuId,
  type LedgerLoan,
  type LoanBrokerState,
  type OpenLendingLoanParams,
  type OpenLendingLoanResult,
  type RepayLoanResult,
  type TxResult,
  type VaultOverview,
  type VaultState,
} from "@moonshift/shared";
import { mockFlag } from "../env.js";
import * as xrpl from "./xrplAdapter.js";
import { swr } from "../lending/swr.js";

export const MOCK = mockFlag("MOCK_XRPL");

export function lendingNetwork(): string {
  return MOCK ? "mock" : networkInfo().name;
}

export function lendingAvailable(): boolean {
  return MOCK || networkInfo().lending;
}

export function addressOf(name: string): string {
  if (MOCK) return name.startsWith("r") ? name : `MOCK_ADDR_${name}`;
  if (name.startsWith("r") && name.length > 24) return name;
  return realXrpl.getAccountAddress(name as AccountName);
}

export function nameOf(addressOrName: string): AccountName | undefined {
  if (!addressOrName.startsWith("r") && !addressOrName.startsWith("MOCK_ADDR_")) return addressOrName as AccountName;
  if (addressOrName.startsWith("MOCK_ADDR_")) return addressOrName.slice(10) as AccountName;
  return MOCK ? undefined : realXrpl.accountNameFor(addressOrName);
}

// ---------------------------------------------------------------------------
// In-memory mock (MOCK_XRPL=1)
// ---------------------------------------------------------------------------

function mockTx(): TxResult {
  const hash = "MOCK" + randomBytes(30).toString("hex").toUpperCase();
  return { hash, result: "tesSUCCESS", validated: true, explorerUrl: explorerUrl(hash) };
}

interface MockRound {
  state: VaultState;
  broker: LoanBrokerState;
  deposits: Map<string, number>;
}
interface MockLoan {
  loan: LedgerLoan;
  name: AccountName;
  principal: number;
  aprPct: number;
}
const mock = { rounds: [] as MockRound[], loans: new Map<string, MockLoan>() };

function mockRound(n: number, phase: VaultState["phase"], assets: number, cover: number): MockRound {
  const now = Date.now();
  const sub = phase === "subscription" ? now + 3 * 86400e3 : now - 3600e3;
  const vaultId = `MOCKVAULT${n}`.padEnd(64, "0");
  const loanBrokerId = `MOCKBROKER${n}`.padEnd(64, "0");
  return {
    deposits: new Map([["BOB", assets * 0.6], ["CAROL", assets * 0.4]]),
    state: {
      round: n,
      vaultId,
      loanBrokerId,
      phase,
      asset: "TDX",
      assetsTotal: fix6(assets),
      assetsAvailable: fix6(assets),
      lossUnrealized: fix6(0),
      debtTotal: fix6(0),
      coverAvailable: fix6(cover),
      utilizationPct: "0.00",
      sharesOutstanding: fix6(assets),
      sharePrice: "1.000000",
      lenderApyPct: "0.00",
      subscriptionDate: new Date(sub).toISOString(),
      redemptionDate: new Date(sub + 14 * 86400e3).toISOString(),
      explorerUrl: "",
    },
    broker: {
      loanBrokerId,
      vaultId,
      owner: "MOCK_ADDR_LENDING_POOL",
      account: `MOCK_ADDR_BROKER_${n}`,
      debtTotal: fix6(0),
      debtMaximum: fix6(0),
      coverAvailable: fix6(cover),
      coverRateMinimumPct: "10.000",
      coverRateLiquidationPct: "50.000",
      managementFeePct: "1.000",
      loansOriginated: 0,
    },
  };
}

export function resetMockLending(): void {
  mock.rounds = [mockRound(1, "investment", 7000, 1000), mockRound(2, "subscription", 1000, 500)];
  mock.loans.clear();
}
resetMockLending();

function mockRefreshRound(r: MockRound) {
  const debt = [...mock.loans.values()]
    .filter((l) => l.loan.round === r.state.round && ["open", "late", "impaired"].includes(l.loan.state))
    .reduce((s, l) => s + Number(l.loan.principalOutstanding), 0);
  const assets = Number(r.state.assetsTotal);
  r.state.debtTotal = fix6(debt);
  r.broker.debtTotal = fix6(debt);
  r.state.assetsAvailable = fix6(assets - debt);
  r.state.utilizationPct = assets > 0 ? ((debt / assets) * 100).toFixed(2) : "0.00";
  const loans = [...mock.loans.values()].filter((l) => l.loan.round === r.state.round && Number(l.loan.principalOutstanding) > 0);
  const w = loans.reduce((s, l) => s + l.principal, 0);
  const apr = w > 0 ? loans.reduce((s, l) => s + l.aprPct * l.principal, 0) / w : 0;
  r.state.lenderApyPct = (apr * 0.99 * (debt / Math.max(1, assets))).toFixed(2);
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export async function vaultOverview(): Promise<VaultOverview> {
  if (MOCK) {
    mock.rounds.forEach(mockRefreshRound);
    const find = (p: VaultState["phase"]) => mock.rounds.find((r) => r.state.phase === p);
    const wrap = (r?: MockRound) => (r ? { ...r.state, broker: r.broker } : null);
    return { network: "mock", simulated: true, investing: wrap(find("investment")), subscribing: wrap(find("subscription")), rounds: mock.rounds.map((r) => r.state) };
  }
  return vaultCache.get("vault", readVaultOverview);
}

// Reading every round from the ledger takes over a second, and /borrow and
// /lend ask for it on every quote. Served from cache (fresh 10 s, then
// refreshed in the background); any vault or loan write here drops it.
const vaultCache = swr<VaultOverview>("vault", 10_000, 30 * 60_000);
const afterWrite = <T>(p: Promise<T>) =>
  p.finally(() => {
    vaultCache.invalidate();
    positionsCache.invalidate();
  });

async function readVaultOverview(): Promise<VaultOverview> {
  const state = realXrpl.loadLendingState();
  const rounds = (await Promise.all(state.rounds.map((r) => realXrpl.getVaultSummary(r.vaultId)))).filter((v): v is VaultState => !!v);
  const pick = (phase: VaultState["phase"]) => [...rounds].reverse().find((x) => x.phase === phase);
  const [investing, subscribing] = await Promise.all(
    [pick("investment"), pick("subscription")].map(async (v) => (v ? { ...v, broker: await realXrpl.getLoanBroker(v.loanBrokerId) } : null))
  );
  return { network: networkInfo().name, simulated: false, investing, subscribing, rounds };
}

function roundFor(round: number | undefined, phase: VaultState["phase"]) {
  if (MOCK) return round ? mock.rounds.find((r) => r.state.round === round) : mock.rounds.find((r) => r.state.phase === phase);
  return undefined;
}

export async function vaultDeposit(lender: AccountName, amount: string, round?: number): Promise<{ tx: TxResult; round: number }> {
  if (MOCK) {
    const r = roundFor(round, "subscription");
    if (!r) throw new Error("NO_SUBSCRIBING_ROUND");
    if (r.state.phase !== "subscription") throw new Error("ROUND_NOT_SUBSCRIBING: deposits are only accepted during the subscription phase");
    const a = Number(amount);
    r.state.assetsTotal = fix6(Number(r.state.assetsTotal) + a);
    r.state.sharesOutstanding = fix6(Number(r.state.sharesOutstanding) + a);
    r.deposits.set(lender, (r.deposits.get(lender) ?? 0) + a);
    return { tx: mockTx(), round: r.state.round };
  }
  const r = round ? realXrpl.findRound(round) : realXrpl.currentRound("subscription");
  if (!r) throw new Error("NO_SUBSCRIBING_ROUND: no round is open for deposits right now.");
  return { tx: await afterWrite(realXrpl.depositToVault({ lender, vaultId: r.vaultId, amount })), round: r.round };
}

export async function vaultWithdraw(lender: AccountName, amount: string, round?: number): Promise<{ tx: TxResult; round: number }> {
  if (MOCK) {
    const r = roundFor(round, "subscription");
    if (!r) throw new Error("NO_ROUND");
    if (r.state.phase === "investment") throw new Error("ROUND_INVESTING: withdrawals open at the redemption date");
    const a = Math.min(Number(amount), r.deposits.get(lender) ?? 0);
    r.state.assetsTotal = fix6(Number(r.state.assetsTotal) - a);
    r.state.sharesOutstanding = fix6(Number(r.state.sharesOutstanding) - a);
    r.deposits.set(lender, (r.deposits.get(lender) ?? 0) - a);
    return { tx: mockTx(), round: r.state.round };
  }
  const r = round ? realXrpl.findRound(round) : realXrpl.currentRound("subscription") ?? realXrpl.currentRound("redemption");
  if (!r) throw new Error("NO_WITHDRAWABLE_ROUND");
  return { tx: await afterWrite(realXrpl.withdrawFromVault({ lender, vaultId: r.vaultId, amount })), round: r.round };
}

// A lender's vault shares per round (shares are worth sharePrice TDX each).
export async function lenderPositions(lender: AccountName): Promise<{ round: number; phase: string; shares: string; value: string }[]> {
  if (MOCK) {
    return mock.rounds.map((r) => {
      const s = r.deposits.get(lender) ?? 0;
      return { round: r.state.round, phase: r.state.phase, shares: fix6(s), value: fix6(s * Number(r.state.sharePrice)) };
    });
  }
  return positionsCache.get(lender, async () => {
    const addr = realXrpl.getAccountAddress(lender);
    return Promise.all(
      realXrpl.loadLendingState().rounds.map(async (r) => {
        const [shares, v] = await Promise.all([realXrpl.getVaultShares(addr, r.shareMptId), realXrpl.getVault(r.vaultId)]);
        return { round: r.round, phase: v?.phase ?? "unknown", shares, value: fix6(Number(shares) * Number(v?.sharePrice ?? 1)) };
      })
    );
  });
}

// Same cache rules as the vault overview: fresh 10 s, dropped on any write.
const positionsCache = swr<{ round: number; phase: string; shares: string; value: string }[]>("positions", 10_000, 30 * 60_000);

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export async function openLoan(p: OpenLendingLoanParams): Promise<OpenLendingLoanResult> {
  if (!MOCK) return afterWrite(realXrpl.openLendingLoan(p));
  const r = roundFor(p.round, "investment");
  if (!r) throw new Error("NO_LENDING_ROUND");
  const principal = Number(p.principal);
  if (principal > Number(r.state.assetsAvailable)) throw new Error("VAULT_INSUFFICIENT_ASSETS");
  const loanId = randomBytes(32).toString("hex").toUpperCase();
  const interval = Math.max(60, p.paymentIntervalSeconds);
  const total = Math.max(1, Math.ceil(p.termSeconds / interval));
  const interest = principal * (p.aprPct / 100) * (p.termSeconds / (365 * 86400));
  const now = Date.now();
  const loan: LedgerLoan = {
    loanId,
    loanBrokerId: r.state.loanBrokerId,
    vaultId: r.state.vaultId,
    round: r.state.round,
    borrower: addressOf(p.borrower),
    state: "open",
    aprPct: p.aprPct.toFixed(3),
    principalOutstanding: fix6(principal),
    totalValueOutstanding: fix6(principal + interest),
    interestOutstanding: fix6(interest),
    managementFeeOutstanding: fix6(interest * 0.01),
    periodicPayment: ceil6((principal + interest) / total),
    paymentRemaining: total,
    paymentIntervalSeconds: interval,
    gracePeriodSeconds: p.gracePeriodSeconds ?? 60,
    startDate: new Date(now).toISOString(),
    nextPaymentDueDate: new Date(now + interval * 1000).toISOString(),
    defaultEligibleAt: new Date(now + (interval + (p.gracePeriodSeconds ?? 60)) * 1000).toISOString(),
    collateral: { gpuId: p.gpuId, shares: fix6(p.collateralShares), owner: addressOf(p.borrower), escrowSequence: 1, nonce: "MOCK", locked: true },
    explorerUrl: "",
  };
  mock.loans.set(loanId, { loan, name: p.borrower, principal, aprPct: p.aprPct });
  r.broker.loansOriginated++;
  mockRefreshRound(r);
  const escrowTx = mockTx();
  const loanSetTx = mockTx();
  return { loanId, round: r.state.round, vaultId: r.state.vaultId, loanBrokerId: r.state.loanBrokerId, escrowTx, loanSetTx, disburseTx: loanSetTx, collateral: loan.collateral!, loan };
}

export async function getLoan(loanId: string): Promise<LedgerLoan | null> {
  if (!MOCK) return realXrpl.getLedgerLoan(loanId);
  const m = mock.loans.get(loanId);
  if (!m) return null;
  if (m.loan.state === "open" && m.loan.nextPaymentDueDate && Date.now() > new Date(m.loan.nextPaymentDueDate).getTime()) m.loan.state = "late";
  return m.loan;
}

export async function repay(loanId: string, mode: "full" | "next"): Promise<RepayLoanResult> {
  if (!MOCK) return afterWrite(realXrpl.repayLendingLoan({ loanId, mode }));
  const m = mock.loans.get(loanId);
  if (!m) throw new Error(`Unknown loanId: ${loanId}`);
  const tx = mockTx();
  if (mode === "next" && m.loan.paymentRemaining > 1) {
    const owed = Number(m.loan.totalValueOutstanding) - Number(m.loan.periodicPayment);
    m.loan.totalValueOutstanding = fix6(owed);
    m.loan.principalOutstanding = fix6(Math.max(0, Number(m.loan.principalOutstanding) - m.principal / (m.loan.paymentRemaining || 1)));
    m.loan.paymentRemaining -= 1;
    m.loan.nextPaymentDueDate = new Date(new Date(m.loan.nextPaymentDueDate ?? Date.now()).getTime() + m.loan.paymentIntervalSeconds * 1000).toISOString();
    mock.rounds.forEach(mockRefreshRound);
    return { ...tx, payments: [tx], paidOff: false, loan: m.loan };
  }
  const releaseTx = mockTx();
  const deleteTx = mockTx();
  mock.loans.delete(loanId);
  const r = mock.rounds.find((x) => x.state.round === m.loan.round);
  if (r) {
    r.state.assetsTotal = fix6(Number(r.state.assetsTotal) + Number(m.loan.interestOutstanding) * 0.99);
    mockRefreshRound(r);
  }
  return { ...tx, payments: [tx], paidOff: true, releaseTx, deleteTx, loan: null };
}

export async function marginCall(loanId: string, observedLtv: string, threshold: string, reason: string): Promise<TxResult> {
  if (!MOCK) return (await realXrpl.marginCall({ loanId, observedLtv, threshold, reason, cureBy: new Date(Date.now() + 10 * 60e3).toISOString() })).memoTx;
  return mockTx();
}

export async function liquidate(loanId: string, reason: string): Promise<{ seizeTx: TxResult | null; defaultTx: TxResult | null; defaultEligibleAt: string | null; defaulted: boolean }> {
  if (!MOCK) return afterWrite(realXrpl.liquidateLoan({ loanId, reason }));
  const m = mock.loans.get(loanId);
  if (!m) throw new Error(`Unknown loanId: ${loanId}`);
  m.loan.collateral = m.loan.collateral ? { ...m.loan.collateral, locked: false } : null;
  m.loan.state = "defaulted";
  const r = mock.rounds.find((x) => x.state.round === m.loan.round);
  if (r) {
    const owed = Number(m.loan.principalOutstanding);
    const drawn = Math.min(owed * 0.1 * 0.5, Number(r.broker.coverAvailable));
    r.broker.coverAvailable = fix6(Number(r.broker.coverAvailable) - drawn);
    r.state.coverAvailable = r.broker.coverAvailable;
    r.state.assetsTotal = fix6(Number(r.state.assetsTotal) - (owed - drawn));
    m.loan.principalOutstanding = fix6(0);
    m.loan.totalValueOutstanding = fix6(0);
    mockRefreshRound(r);
  }
  return { seizeTx: mockTx(), defaultTx: mockTx(), defaultEligibleAt: null, defaulted: true };
}

export async function defaultLoan(loanId: string): Promise<TxResult | null> {
  if (!MOCK) return afterWrite(realXrpl.defaultLoan(loanId));
  return null; // mock liquidations default immediately
}

// ---------------------------------------------------------------------------
// Oracle: the collateral price (TDX per GPU share)
// ---------------------------------------------------------------------------

const DEFAULT_NAV = "5.000000";

export async function oraclePrice(gpuId: GpuId): Promise<{ price: string; updatedAt: string | null; source: "live" | "mock" }> {
  if (MOCK) {
    const o = xrpl.getOracle(gpuId);
    const price = Number(o.navPerShare) > 0 ? fix6(o.navPerShare) : DEFAULT_NAV;
    return { price, updatedAt: o.publishedAt ?? null, source: "mock" };
  }
  const r = await realXrpl.readOracle(gpuId);
  return { price: r && Number(r.navPerShare) > 0 ? r.navPerShare : DEFAULT_NAV, updatedAt: r?.lastUpdateTime ?? null, source: "live" };
}

export async function publishPrice(gpuId: GpuId, navPerShare: string): Promise<TxResult> {
  const current = MOCK ? null : await realXrpl.readOracle(gpuId).catch(() => null);
  return xrpl.publishOracle({
    gpuId,
    navPerShare: fix6(navPerShare),
    gpuHourPrice: current?.gpuHourPrice ?? "3.000000",
    utilizationPct: current?.utilizationPct ?? "20.00",
  });
}

export { rippleToIso };

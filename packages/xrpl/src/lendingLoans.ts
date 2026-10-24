// XLS-66 loans from a vault round, with GPU shares escrowed as collateral.
// Verified behaviors on devnet (see docs/SPIKE_DEVNET_LENDING.md):
// - LoanSet: broker is Account and signs first, borrower countersigns.
//   Principal goes from the vault straight to the borrower.
// - Only the borrower can LoanPay. The full-payment flag is rejected when one
//   payment remains (tecKILLED), so the last installment is a plain payment.
// - LoanManage impair is only allowed once a payment is late (tecTOO_SOON
//   before). Default needs due date + grace period.
// So a margin call is an on-ledger memo plus api state, and liquidation is
// "seize the collateral now, default the XLS-66 loan as soon as the ledger
// allows". First-loss cover absorbs the vault's share of the loss.

import { decode, LoanManageFlags, LoanPayFlags, signLoanSetByCounterparty, type LoanSet } from "xrpl";
import {
  ceil6,
  fix6,
  networkName,
  accountExplorerUrl,
  rippleToIso,
  tenthBpsToPct,
  pctToTenthBps,
  type AccountName,
  type CollateralLock,
  type GpuId,
  type LedgerLoan,
  type LedgerLoanState,
  type LendingRound,
  type LiquidationResult,
  type MarginCallResult,
  type OpenLendingLoanParams,
  type OpenLendingLoanResult,
  type RepayLoanResult,
  type TxResult,
} from "@moonshift/shared";
import { createdEntryId, getClient, getLedgerEntry, ledgerCloseTime, submitTx, submitTxFull } from "./client.js";
import fs from "node:fs";
import path from "node:path";
import { ALL_ACCOUNT_NAMES, getAccountAddress, getAccountWallet, REPO_ROOT } from "./wallets.js";
import { BROKER_ACCOUNT, currentRound, findRound, loadLendingState, must, tdx } from "./lending.js";
import { escrowExists, lockCollateral, memo, newNonce, releaseCollateral, seizeCollateral } from "./collateral.js";
import { LedgerRejected } from "./errors.js";

const LSF_LOAN_DEFAULT = 0x00010000;
const LSF_LOAN_IMPAIRED = 0x00020000;
const TF_LOAN_OVERPAYMENT = 0x00010000; // LoanSet: allow principal prepayment (margin call cure)
export const DEFAULT_GRACE_SECONDS = 60;

export function accountNameFor(address: string): AccountName | undefined {
  for (const n of ALL_ACCOUNT_NAMES) {
    try {
      if (getAccountAddress(n) === address) return n;
    } catch {
      // account not configured on this network
    }
  }
  return undefined;
}

interface LoanData {
  v: number;
  g: string; // gpuId
  s: string; // collateral shares
  e: number; // escrow sequence
  n: string; // nonce
}

function encodeData(d: LoanData): string {
  return Buffer.from(JSON.stringify(d), "utf8").toString("hex").toUpperCase();
}

function decodeData(hex?: string): LoanData | null {
  if (!hex) return null;
  try {
    const d = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
    return d && d.v === 1 ? d : null;
  } catch {
    return null;
  }
}

// Loan entries do not keep LoanSet's Data field, so the loan -> escrow link
// lives in two places: a public index file (fast path) and the LoanSet
// transaction itself, found in the borrower's history (ledger-only fallback).
type CollateralRef = Omit<CollateralLock, "locked">;

function collateralIndexPath(): string {
  return path.join(REPO_ROOT, "contracts", `collateral.${networkName()}.json`);
}

function loadCollateralIndex(): Record<string, CollateralRef> {
  try {
    const raw = JSON.parse(fs.readFileSync(collateralIndexPath(), "utf8"));
    return raw.loans ?? {};
  } catch {
    return {};
  }
}

function saveCollateralRef(loanId: string, ref: CollateralRef): void {
  const loans = { ...loadCollateralIndex(), [loanId]: ref };
  fs.mkdirSync(path.dirname(collateralIndexPath()), { recursive: true });
  fs.writeFileSync(
    collateralIndexPath(),
    JSON.stringify({ _note: "Public loan -> collateral escrow links. Rebuildable from LoanSet Data on ledger. No secrets.", loans }, null, 2) + "\n"
  );
}

async function collateralFromLedger(loanId: string, borrower: string): Promise<CollateralRef | null> {
  const client = await getClient();
  let marker: unknown;
  for (let page = 0; page < 5; page++) {
    let res: any;
    try {
      res = await client.request({ command: "account_tx", account: borrower, limit: 200, ...(marker ? { marker } : {}) } as any);
    } catch {
      return null;
    }
    for (const t of res.result.transactions ?? []) {
      const tx = t.tx_json ?? t.tx;
      if (tx?.TransactionType !== "LoanSet") continue;
      const createdHere = (t.meta?.AffectedNodes ?? []).some((n: any) => n.CreatedNode?.LedgerEntryType === "Loan" && n.CreatedNode.LedgerIndex === loanId);
      if (!createdHere) continue;
      const d = decodeData(tx.Data);
      if (!d) return null;
      return { gpuId: d.g, shares: fix6(d.s), owner: borrower, escrowSequence: d.e, nonce: d.n };
    }
    marker = res.result.marker;
    if (!marker) break;
  }
  return null;
}

export async function findCollateral(loanId: string, borrower: string): Promise<CollateralRef | null> {
  const cached = loadCollateralIndex()[loanId];
  if (cached) return cached;
  const found = await collateralFromLedger(loanId, borrower);
  if (found) saveCollateralRef(loanId, found);
  return found;
}

function roundForBroker(loanBrokerId: string): LendingRound | undefined {
  return loadLendingState().rounds.find((r) => r.loanBrokerId === loanBrokerId);
}

// Ledger Loan entry -> LedgerLoan. Checks the escrow so `collateral.locked`
// is live.
export async function toLedgerLoan(loanId: string, e: any, nowRipple?: number): Promise<LedgerLoan> {
  const now = nowRipple ?? (await ledgerCloseTime());
  const round = roundForBroker(e.LoanBrokerID);
  const ref = await findCollateral(loanId, e.Borrower);
  const tvo = Number(e.TotalValueOutstanding ?? 0);
  const principal = Number(e.PrincipalOutstanding ?? 0);
  const flags = Number(e.Flags ?? 0);
  const due = e.NextPaymentDueDate ? Number(e.NextPaymentDueDate) : null;
  const grace = Number(e.GracePeriod ?? 0);

  let state: LedgerLoanState = "open";
  if (flags & LSF_LOAN_DEFAULT) state = "defaulted";
  else if (tvo <= 0) state = "repaid";
  else if (flags & LSF_LOAN_IMPAIRED) state = "impaired";
  else if (due !== null && now > due) state = "late";

  const collateral: CollateralLock | null = ref ? { ...ref, locked: await escrowExists(ref.owner, ref.escrowSequence) } : null;

  return {
    loanId,
    loanBrokerId: e.LoanBrokerID,
    vaultId: round?.vaultId ?? "",
    round: round?.round ?? 0,
    borrower: e.Borrower,
    state,
    aprPct: tenthBpsToPct(e.InterestRate),
    principalOutstanding: fix6(principal),
    totalValueOutstanding: fix6(tvo),
    interestOutstanding: fix6(Math.max(0, tvo - principal)),
    managementFeeOutstanding: fix6(e.ManagementFeeOutstanding),
    periodicPayment: ceil6(e.PeriodicPayment ?? 0),
    paymentRemaining: Number(e.PaymentRemaining ?? 0),
    paymentIntervalSeconds: Number(e.PaymentInterval ?? 0),
    gracePeriodSeconds: grace,
    startDate: rippleToIso(Number(e.StartDate ?? 0)),
    nextPaymentDueDate: due !== null && tvo > 0 ? rippleToIso(due) : null,
    defaultEligibleAt: due !== null && tvo > 0 ? rippleToIso(due + grace) : null,
    collateral,
    explorerUrl: accountExplorerUrl(e.Borrower),
  };
}

export async function getLedgerLoan(loanId: string): Promise<LedgerLoan | null> {
  const e = await getLedgerEntry(loanId);
  return e ? toLedgerLoan(loanId, e) : null;
}

// Every loan still on ledger, read from each round's broker pseudo-account.
export async function listLedgerLoans(opts: { round?: number } = {}): Promise<LedgerLoan[]> {
  const client = await getClient();
  const now = await ledgerCloseTime();
  const rounds = loadLendingState().rounds.filter((r) => opts.round === undefined || r.round === opts.round);
  const out: LedgerLoan[] = [];
  for (const r of rounds) {
    let marker: unknown;
    do {
      let res: any;
      try {
        res = await client.request({
          command: "account_objects",
          account: r.brokerAccount,
          type: "loan",
          ledger_index: "validated",
          ...(marker ? { marker } : {}),
        } as any);
      } catch {
        break; // pseudo-account gone (devnet reset)
      }
      for (const o of res.result.account_objects ?? []) {
        out.push(await toLedgerLoan(o.index, o, now));
      }
      marker = res.result.marker;
    } while (marker);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openLendingLoan(p: OpenLendingLoanParams): Promise<OpenLendingLoanResult> {
  const round = p.round !== undefined ? findRound(p.round) : currentRound("investment");
  if (!round) throw new Error("NO_LENDING_ROUND: no vault round is in its investment phase. Run NETWORK=devnet npm run xrpl:setup.");

  const broker = getAccountWallet(BROKER_ACCOUNT);
  const borrower = getAccountWallet(p.borrower);
  const grace = Math.max(60, Math.floor(p.gracePeriodSeconds ?? DEFAULT_GRACE_SECONDS));
  const interval = Math.max(60, Math.floor(p.paymentIntervalSeconds));
  const total = Math.max(1, Math.ceil(p.termSeconds / interval));
  const nonce = newNonce();
  const maturity = Date.now() + (total * interval + grace) * 1000;
  if (maturity >= new Date(round.redemptionDate).getTime()) {
    throw new Error(
      `LOAN_TERM_PAST_REDEMPTION: the loan would mature after round ${round.round} redeems (${round.redemptionDate}); shorten the term`
    );
  }

  // 1. Collateral. CancelAfter sits well past maturity + grace.
  const lock = await lockCollateral({
    borrower,
    gpuId: p.gpuId,
    shares: p.collateralShares,
    nonce,
    cancelAfterSeconds: total * interval + grace + 3600,
  });
  const collateral: CollateralLock = {
    gpuId: p.gpuId,
    shares: fix6(p.collateralShares),
    owner: borrower.address,
    escrowSequence: lock.escrowSequence,
    nonce,
    locked: true,
  };

  // 2. LoanSet: broker signs, borrower countersigns.
  const client = await getClient();
  const prev = console.warn;
  console.warn = () => {}; // autofill warns about LoanSet fee calculation
  let prepared: LoanSet;
  try {
    prepared = (await client.autofill({
      TransactionType: "LoanSet",
      Account: broker.address,
      Counterparty: borrower.address,
      LoanBrokerID: round.loanBrokerId,
      PrincipalRequested: fix6(p.principal),
      InterestRate: pctToTenthBps(p.aprPct),
      PaymentTotal: total,
      PaymentInterval: interval,
      GracePeriod: grace,
      Flags: TF_LOAN_OVERPAYMENT,
      Data: encodeData({ v: 1, g: p.gpuId, s: fix6(p.collateralShares), e: lock.escrowSequence, n: nonce }),
      Memos: memo("MS_LOAN_DISBURSE", { nonce, gpuId: p.gpuId, principal: fix6(p.principal), round: round.round }),
    } as LoanSet)) as LoanSet;
  } finally {
    console.warn = prev;
  }
  const brokerSigned = decode(broker.sign(prepared).tx_blob) as unknown as LoanSet;
  const full = signLoanSetByCounterparty(borrower, brokerSigned);
  const { txResult: loanSetTx, response } = await submitTxFull(broker, prepared as any, { signedBlob: full.tx_blob });

  if (loanSetTx.result !== "tesSUCCESS") {
    // Undo the collateral lock so the borrower is not left with frozen shares.
    await releaseCollateral(collateral, "loanset-failed").catch(() => {});
    throw new LedgerRejected(loanSetTx.result, `LoanSet failed: ${loanSetTx.result}`, loanSetTx.hash);
  }
  const loanId = createdEntryId(response, "Loan")!;
  const { locked: _locked, ...ref } = collateral;
  saveCollateralRef(loanId, ref);
  return {
    loanId,
    round: round.round,
    vaultId: round.vaultId,
    loanBrokerId: round.loanBrokerId,
    escrowTx: lock.tx,
    loanSetTx,
    disburseTx: loanSetTx,
    collateral,
    loan: await getLedgerLoan(loanId),
  };
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

function borrowerWalletFor(loan: { borrower: string }) {
  const name = accountNameFor(loan.borrower);
  if (!name) throw new Error(`Borrower ${loan.borrower} is not a configured account; it must sign LoanPay itself.`);
  return getAccountWallet(name);
}

async function pay(loanId: string, borrower: ReturnType<typeof getAccountWallet>, amount: string, flags: number | undefined, kind: string, dueIso: string | null) {
  return submitTx(borrower, {
    TransactionType: "LoanPay",
    Account: borrower.address,
    LoanID: loanId,
    Amount: tdx(amount),
    ...(flags ? { Flags: flags } : {}),
    Memos: memo("MS_REPAY", { loanId, kind, onTime: dueIso ? Date.now() <= new Date(dueIso).getTime() : true }),
  } as any);
}

// mode "full" pays the loan off (then releases collateral and deletes the
// loan). mode "next" pays one installment.
export async function repayLendingLoan(p: { loanId: string; mode?: "full" | "next" }): Promise<RepayLoanResult> {
  const mode = p.mode ?? "full";
  let loan = await getLedgerLoan(p.loanId);
  if (!loan) throw new Error(`Unknown loanId: ${p.loanId}`);
  if (loan.state === "defaulted") throw new Error(`Loan ${p.loanId} is defaulted`);
  const borrower = borrowerWalletFor(loan);
  const payments: TxResult[] = [];

  if (Number(loan.totalValueOutstanding) > 0) {
    if (mode === "next") {
      payments.push(must(await pay(p.loanId, borrower, loan.periodicPayment, undefined, "installment", loan.nextPaymentDueDate), "LoanPay"));
    } else {
      if (loan.paymentRemaining > 1) {
        const tx = await pay(p.loanId, borrower, ceil6(loan.totalValueOutstanding), LoanPayFlags.tfLoanFullPayment, "payoff", loan.nextPaymentDueDate);
        payments.push(tx);
        loan = await getLedgerLoan(p.loanId);
      }
      // Full-payment flag refused (or one installment left): pay installments.
      for (let i = 0; loan && Number(loan.totalValueOutstanding) > 0 && i < loan.paymentRemaining + 1; i++) {
        payments.push(must(await pay(p.loanId, borrower, loan.periodicPayment, undefined, "installment", loan.nextPaymentDueDate), "LoanPay"));
        loan = await getLedgerLoan(p.loanId);
      }
    }
  }

  loan = await getLedgerLoan(p.loanId);
  const paidOff = !loan || Number(loan.totalValueOutstanding) <= 0;
  let releaseTx: TxResult | undefined;
  let deleteTx: TxResult | undefined;
  if (paidOff && loan) {
    if (loan.collateral?.locked) releaseTx = await releaseCollateral(loan.collateral, p.loanId);
    deleteTx = await submitTx(getAccountWallet(BROKER_ACCOUNT), { TransactionType: "LoanDelete", LoanID: p.loanId } as any);
    loan = await getLedgerLoan(p.loanId);
  }

  const last = payments.filter((t) => t.result === "tesSUCCESS").at(-1) ?? payments.at(-1) ?? releaseTx;
  return {
    hash: last?.hash ?? "",
    result: last?.result ?? "tesSUCCESS",
    validated: last?.validated ?? true,
    explorerUrl: last?.explorerUrl ?? "",
    payments,
    paidOff,
    releaseTx,
    deleteTx,
    loan,
  };
}

// Principal prepayment (needs the loan's overpayment flag, set at LoanSet).
// This is how a borrower cures a margin call without adding collateral. The
// ledger applies an overpayment only on top of the current installment
// (less fails with tecINSUFFICIENT_PAYMENT), so the payment is the next
// installment plus `extraPrincipal`.
export async function prepayLoan(p: { loanId: string; extraPrincipal: string }): Promise<TxResult> {
  const loan = await getLedgerLoan(p.loanId);
  if (!loan) throw new Error(`Unknown loanId: ${p.loanId}`);
  const borrower = borrowerWalletFor(loan);
  const amount = ceil6(Number(loan.periodicPayment) + Number(p.extraPrincipal));
  return must(await pay(p.loanId, borrower, amount, LoanPayFlags.tfLoanOverpayment, "prepay", loan.nextPaymentDueDate), "LoanPay (prepay)");
}

// ---------------------------------------------------------------------------
// Margin call, late payment, liquidation, default
// ---------------------------------------------------------------------------

// On-ledger margin call notice: 1 drop from the broker to the borrower with an
// MS_MARGIN_CALL memo, so the borrower's own history shows it (the credit
// service reads these).
export async function marginCall(p: {
  loanId: string;
  observedLtv: string;
  threshold: string;
  reason?: string;
  cureBy?: string;
}): Promise<MarginCallResult> {
  const loan = await getLedgerLoan(p.loanId);
  if (!loan) throw new Error(`Unknown loanId: ${p.loanId}`);
  const broker = getAccountWallet(BROKER_ACCOUNT);
  const memoTx = must(
    await submitTx(broker, {
      TransactionType: "Payment",
      Account: broker.address,
      Destination: loan.borrower,
      Amount: "1",
      Memos: memo("MS_MARGIN_CALL", {
        loanId: p.loanId,
        ltv: p.observedLtv,
        threshold: p.threshold,
        reason: p.reason ?? "LTV_ABOVE_MARGIN_CALL",
        cureBy: p.cureBy ?? null,
      }),
    } as any),
    "margin call memo"
  );
  return { memoTx, loanId: p.loanId, observedLtv: p.observedLtv, threshold: p.threshold };
}

// Flag a late loan as impaired (paper loss on the vault). The ledger refuses
// this before the due date.
export async function impairLoan(loanId: string): Promise<TxResult> {
  return submitTx(getAccountWallet(BROKER_ACCOUNT), {
    TransactionType: "LoanManage",
    LoanID: loanId,
    Flags: LoanManageFlags.tfLoanImpair,
  } as any);
}

export async function unimpairLoan(loanId: string): Promise<TxResult> {
  return submitTx(getAccountWallet(BROKER_ACCOUNT), {
    TransactionType: "LoanManage",
    LoanID: loanId,
    Flags: LoanManageFlags.tfLoanUnimpair,
  } as any);
}

// Default on the XLS-66 ledger if the ledger allows it now. Returns null
// (no transaction) while it is still too early.
export async function defaultLoan(loanId: string): Promise<TxResult | null> {
  const loan = await getLedgerLoan(loanId);
  if (!loan || loan.state === "defaulted" || loan.state === "repaid") return null;
  if (!loan.defaultEligibleAt || Date.now() < new Date(loan.defaultEligibleAt).getTime()) return null;
  const tx = await submitTx(getAccountWallet(BROKER_ACCOUNT), {
    TransactionType: "LoanManage",
    LoanID: loanId,
    Flags: LoanManageFlags.tfLoanDefault,
  } as any);
  return tx.result === "tesSUCCESS" ? tx : null;
}

// Liquidate: seize the escrowed GPU shares now, then default the XLS-66 loan
// as soon as the ledger allows. If the loan is already late it is impaired
// first, which pulls the default window forward.
export async function liquidateLoan(p: { loanId: string; reason?: string }): Promise<LiquidationResult> {
  let loan = await getLedgerLoan(p.loanId);
  if (!loan) throw new Error(`Unknown loanId: ${p.loanId}`);

  let seizeTx: TxResult | null = null;
  if (loan.collateral?.locked) {
    seizeTx = await seizeCollateral(loan.collateral, p.loanId, p.reason ?? "LTV_ABOVE_LIQUIDATION");
  }
  if (loan.state === "late") {
    await impairLoan(p.loanId);
    loan = await getLedgerLoan(p.loanId);
  }
  const defaultTx = await defaultLoan(p.loanId);
  loan = await getLedgerLoan(p.loanId);
  return {
    loanId: p.loanId,
    seizeTx,
    defaultTx,
    defaulted: loan?.state === "defaulted",
    defaultEligibleAt: loan?.defaultEligibleAt ?? null,
  };
}

// Weighted APR of open loans in a round, for the lender APY estimate.
export async function weightedAprPct(round?: number): Promise<number> {
  const loans = (await listLedgerLoans({ round })).filter((l) => Number(l.principalOutstanding) > 0 && l.state !== "defaulted");
  const total = loans.reduce((s, l) => s + Number(l.principalOutstanding), 0);
  if (total <= 0) return 0;
  return loans.reduce((s, l) => s + Number(l.aprPct) * Number(l.principalOutstanding), 0) / total;
}

export type { GpuId };

// Vault state with lender APY from the round's actual open loans.
export async function getVaultSummary(vaultId: string) {
  const { getVault } = await import("./lending.js");
  const round = loadLendingState().rounds.find((r) => r.vaultId === vaultId);
  return getVault(vaultId, { weightedAprPct: await weightedAprPct(round?.round) });
}

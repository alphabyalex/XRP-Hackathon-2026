// XLS-65 vaults and XLS-66 loan brokers (devnet). The Moonshift broker is the
// LENDING_POOL account: it owns every vault and loan broker, because only the
// vault owner may run LoanBrokerSet. See docs/SPIKE_DEVNET_LENDING.md.
//
// Lending runs in rounds. LendingProtocolV1_1 requires a closed-ended vault
// for a new broker, so a round collects deposits (subscription), lends
// (investment), then pays lenders out (redemption).

import fs from "node:fs";
import path from "node:path";
import {
  accountExplorerUrl,
  fix6,
  networkName,
  pctToTenthBps,
  rippleToIso,
  tenthBpsToPct,
  vaultPhase,
  type AccountName,
  type LendingRound,
  type LendingStateFile,
  type LoanBrokerState,
  type TxResult,
  type VaultPhase,
  type VaultState,
} from "@moonshift/shared";
import {
  createdEntryFields,
  createdEntryId,
  getClient,
  getLedgerEntry,
  ledgerCloseTime,
  submitTx,
  submitTxFull,
} from "./client.js";
import { getAccountAddress, getAccountWallet, REPO_ROOT } from "./wallets.js";
import { LedgerRejected } from "./errors.js";

export const BROKER_ACCOUNT: AccountName = "LENDING_POOL";

// Defaults for every round's broker. Percent, converted to 1/10 bp on ledger.
export const BROKER_DEFAULTS = {
  managementFeePct: 1, // broker keeps 1% of interest
  coverRateMinimumPct: 10, // first-loss cover must be >= 10% of debt
  coverRateLiquidationPct: 50, // up to 50% of minimum cover is drawn on a default
};

function hex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex").toUpperCase();
}

export function tdx(value: string) {
  return { currency: "TDX", issuer: getAccountAddress("TDX_ISSUER"), value };
}

// tec results are on-ledger failures. Lending callers want them as errors.
export function must(tx: TxResult, what: string): TxResult {
  if (tx.result !== "tesSUCCESS") {
    throw new LedgerRejected(tx.result, `${what} failed: ${tx.result}`, tx.hash);
  }
  return tx;
}

// ---------------------------------------------------------------------------
// Round state (public IDs only): contracts/lending.<network>.json
// ---------------------------------------------------------------------------

export function lendingStatePath(net = networkName()): string {
  return path.join(REPO_ROOT, "contracts", `lending.${net}.json`);
}

export function loadLendingState(): LendingStateFile {
  const file = lendingStatePath();
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return { network: raw.network, broker: raw.broker, rounds: raw.rounds ?? [] };
    } catch {
      // fall through to empty
    }
  }
  return { network: networkName(), broker: "", rounds: [] };
}

export function saveLendingState(state: LendingStateFile): void {
  const file = lendingStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    _note: `Public XLS-65/66 IDs on ${networkName()}, written by packages/xrpl. Safe to commit. Never put seeds here.`,
    ...state,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function roundPhase(r: LendingRound, now = new Date()): VaultPhase {
  return vaultPhase(r.subscriptionDate, r.redemptionDate, now);
}

// The newest round in the given phase, if any.
export function currentRound(phase: VaultPhase): LendingRound | undefined {
  return [...loadLendingState().rounds].reverse().find((r) => roundPhase(r) === phase);
}

export function findRound(idOrRound: string | number): LendingRound | undefined {
  const rounds = loadLendingState().rounds;
  return rounds.find((r) => r.round === Number(idOrRound) || r.vaultId === idOrRound || r.loanBrokerId === idOrRound);
}

// ---------------------------------------------------------------------------
// Vaults (XLS-65)
// ---------------------------------------------------------------------------

export interface CreateVaultParams {
  subscriptionSeconds: number; // deposit window from now (min ~60 on devnet)
  termSeconds: number; // investment phase length (>= 180 by protocol)
  label?: string;
}

export interface CreateVaultResult {
  vaultId: string;
  vaultAccount: string;
  shareMptId: string;
  subscriptionDate: string;
  redemptionDate: string;
  tx: TxResult;
}

export async function createVault(p: CreateVaultParams): Promise<CreateVaultResult> {
  const broker = getAccountWallet(BROKER_ACCOUNT);
  const now = await ledgerCloseTime();
  const subscriptionDate = now + Math.max(30, Math.floor(p.subscriptionSeconds));
  const redemptionDate = subscriptionDate + Math.max(180, Math.floor(p.termSeconds));
  const { txResult, response } = await submitTxFull(broker, {
    TransactionType: "VaultCreate",
    Account: broker.address,
    Asset: { currency: "TDX", issuer: getAccountAddress("TDX_ISSUER") },
    Data: hex(p.label ?? "Moonshift GPU credit vault"),
    VaultKind: 1, // closed-ended
    SubscriptionDate: subscriptionDate,
    RedemptionDate: redemptionDate,
  } as any);
  must(txResult, "VaultCreate");
  const vaultId = createdEntryId(response, "Vault")!;
  const fields = createdEntryFields(response, "Vault") ?? {};
  return {
    vaultId,
    vaultAccount: fields.Account,
    shareMptId: fields.ShareMPTID,
    subscriptionDate: rippleToIso(subscriptionDate),
    redemptionDate: rippleToIso(redemptionDate),
    tx: txResult,
  };
}

export async function depositToVault(p: { lender: AccountName; vaultId: string; amount: string }): Promise<TxResult> {
  const w = getAccountWallet(p.lender);
  return must(
    await submitTx(w, { TransactionType: "VaultDeposit", Account: w.address, VaultID: p.vaultId, Amount: tdx(fix6(p.amount)) } as any),
    "VaultDeposit"
  );
}

export async function withdrawFromVault(p: { lender: AccountName; vaultId: string; amount: string }): Promise<TxResult> {
  const w = getAccountWallet(p.lender);
  return must(
    await submitTx(w, { TransactionType: "VaultWithdraw", Account: w.address, VaultID: p.vaultId, Amount: tdx(fix6(p.amount)) } as any),
    "VaultWithdraw"
  );
}

// Vault shares a lender holds. The share MPT is an integer amount scaled by
// the vault's Scale (6 for TDX), so 4000000000 raw = 4000 shares.
export async function getVaultShares(account: string, shareMptId: string, scale = 6): Promise<string> {
  const client = await getClient();
  try {
    const res = await client.request({ command: "account_objects", account, type: "mptoken", ledger_index: "validated" } as any);
    const tok = (res.result as any).account_objects?.find((o: any) => o.MPTokenIssuanceID === shareMptId);
    return fix6(Number(tok?.MPTAmount ?? 0) / 10 ** scale);
  } catch {
    return "0.000000";
  }
}

export interface VaultStateOptions {
  weightedAprPct?: number; // from open loans; falls back to 0
}

export async function getVault(vaultId: string, opts: VaultStateOptions = {}): Promise<VaultState | null> {
  const v = await getLedgerEntry(vaultId);
  if (!v) return null;
  const round = loadLendingState().rounds.find((r) => r.vaultId === vaultId);
  const broker = round ? await getLedgerEntry(round.loanBrokerId) : null;

  const scale = Number(v.Scale ?? 6);
  let sharesRaw = "0";
  try {
    const client = await getClient();
    const mpt = await client.request({ command: "ledger_entry", mpt_issuance: v.ShareMPTID, ledger_index: "validated" } as any);
    sharesRaw = String((mpt.result as any).node?.OutstandingAmount ?? "0");
  } catch {
    // share issuance not found; leave at zero
  }
  const shares = Number(sharesRaw) / 10 ** scale;
  const assetsTotal = Number(v.AssetsTotal ?? 0);
  const debtTotal = Number(broker?.DebtTotal ?? 0);
  const utilization = assetsTotal > 0 ? debtTotal / assetsTotal : 0;
  const mgmt = Number(broker?.ManagementFeeRate ?? 0) / 100000;
  const apy = (opts.weightedAprPct ?? 0) * (1 - mgmt) * utilization;
  const sub = v.SubscriptionDate ? rippleToIso(v.SubscriptionDate) : round?.subscriptionDate ?? "";
  const red = v.RedemptionDate ? rippleToIso(v.RedemptionDate) : round?.redemptionDate ?? "";

  return {
    round: round?.round ?? 0,
    vaultId,
    loanBrokerId: round?.loanBrokerId ?? "",
    phase: sub && red ? vaultPhase(sub, red) : "investment",
    asset: "TDX",
    assetsTotal: fix6(assetsTotal),
    assetsAvailable: fix6(v.AssetsAvailable),
    lossUnrealized: fix6(v.LossUnrealized),
    debtTotal: fix6(debtTotal),
    coverAvailable: fix6(broker?.CoverAvailable),
    utilizationPct: (utilization * 100).toFixed(2),
    sharesOutstanding: fix6(shares),
    sharePrice: shares > 0 ? (assetsTotal / shares).toFixed(6) : "1.000000",
    lenderApyPct: apy.toFixed(2),
    subscriptionDate: sub,
    redemptionDate: red,
    explorerUrl: accountExplorerUrl(v.Account),
  };
}

// ---------------------------------------------------------------------------
// Loan brokers (XLS-66)
// ---------------------------------------------------------------------------

export interface SetupLoanBrokerParams {
  vaultId: string;
  managementFeePct?: number;
  coverRateMinimumPct?: number;
  coverRateLiquidationPct?: number;
  label?: string;
}

export async function setupLoanBroker(p: SetupLoanBrokerParams): Promise<{ loanBrokerId: string; brokerAccount: string; tx: TxResult }> {
  const broker = getAccountWallet(BROKER_ACCOUNT);
  const { txResult, response } = await submitTxFull(broker, {
    TransactionType: "LoanBrokerSet",
    Account: broker.address,
    VaultID: p.vaultId,
    Data: hex(p.label ?? "Moonshift GPU-share credit desk"),
    ManagementFeeRate: pctToTenthBps(p.managementFeePct ?? BROKER_DEFAULTS.managementFeePct),
    CoverRateMinimum: pctToTenthBps(p.coverRateMinimumPct ?? BROKER_DEFAULTS.coverRateMinimumPct),
    CoverRateLiquidation: pctToTenthBps(p.coverRateLiquidationPct ?? BROKER_DEFAULTS.coverRateLiquidationPct),
  } as any);
  must(txResult, "LoanBrokerSet");
  return {
    loanBrokerId: createdEntryId(response, "LoanBroker")!,
    brokerAccount: createdEntryFields(response, "LoanBroker")?.Account,
    tx: txResult,
  };
}

export async function depositCover(p: { loanBrokerId: string; amount: string }): Promise<TxResult> {
  const broker = getAccountWallet(BROKER_ACCOUNT);
  return must(
    await submitTx(broker, {
      TransactionType: "LoanBrokerCoverDeposit",
      Account: broker.address,
      LoanBrokerID: p.loanBrokerId,
      Amount: tdx(fix6(p.amount)),
    } as any),
    "LoanBrokerCoverDeposit"
  );
}

export async function getLoanBroker(loanBrokerId: string): Promise<LoanBrokerState | null> {
  const b = await getLedgerEntry(loanBrokerId);
  if (!b) return null;
  return {
    loanBrokerId,
    vaultId: b.VaultID,
    owner: b.Owner,
    account: b.Account,
    debtTotal: fix6(b.DebtTotal),
    debtMaximum: fix6(b.DebtMaximum),
    coverAvailable: fix6(b.CoverAvailable),
    coverRateMinimumPct: tenthBpsToPct(b.CoverRateMinimum),
    coverRateLiquidationPct: tenthBpsToPct(b.CoverRateLiquidation),
    managementFeePct: tenthBpsToPct(b.ManagementFeeRate),
    loansOriginated: Math.max(0, Number(b.LoanSequence ?? 1) - 1),
  };
}

// ---------------------------------------------------------------------------
// Rounds: vault + broker + cover + seed deposits, recorded in the state file
// ---------------------------------------------------------------------------

export interface CreateRoundParams {
  subscriptionSeconds: number;
  termSeconds: number;
  coverAmount: string;
  seedDeposits?: { lender: AccountName; amount: string }[];
  waitForInvestment?: boolean; // block until loans can be originated
  log?: (msg: string) => void;
}

export async function createRound(p: CreateRoundParams): Promise<LendingRound> {
  const log = p.log ?? (() => {});
  const state = loadLendingState();
  const n = (state.rounds.at(-1)?.round ?? 0) + 1;

  const vault = await createVault({
    subscriptionSeconds: p.subscriptionSeconds,
    termSeconds: p.termSeconds,
    label: `Moonshift GPU credit, round ${n}`,
  });
  log(`round ${n}: VaultCreate ${vault.tx.hash}`);

  for (const d of p.seedDeposits ?? []) {
    const tx = await depositToVault({ lender: d.lender, vaultId: vault.vaultId, amount: d.amount });
    log(`round ${n}: ${d.lender} deposits ${d.amount} TDX ${tx.hash}`);
  }

  const broker = await setupLoanBroker({ vaultId: vault.vaultId, label: `Moonshift credit desk, round ${n}` });
  log(`round ${n}: LoanBrokerSet ${broker.tx.hash}`);
  if (Number(p.coverAmount) > 0) {
    const tx = await depositCover({ loanBrokerId: broker.loanBrokerId, amount: p.coverAmount });
    log(`round ${n}: cover ${p.coverAmount} TDX ${tx.hash}`);
  }

  const round: LendingRound = {
    round: n,
    vaultId: vault.vaultId,
    loanBrokerId: broker.loanBrokerId,
    vaultAccount: vault.vaultAccount,
    brokerAccount: broker.brokerAccount,
    shareMptId: vault.shareMptId,
    subscriptionDate: vault.subscriptionDate,
    redemptionDate: vault.redemptionDate,
    createdTx: vault.tx.hash,
  };
  state.network = networkName();
  state.broker = getAccountAddress(BROKER_ACCOUNT);
  state.rounds.push(round);
  saveLendingState(state);

  if (p.waitForInvestment) {
    const target = Math.floor(new Date(vault.subscriptionDate).getTime() / 1000) - 946684800;
    log(`round ${n}: waiting for investment phase`);
    while ((await ledgerCloseTime()) <= target) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return round;
}

// Drop rounds whose vault no longer exists (devnet reset). Returns live rounds.
export async function pruneRounds(): Promise<LendingRound[]> {
  const state = loadLendingState();
  const live: LendingRound[] = [];
  for (const r of state.rounds) {
    if (await getLedgerEntry(r.vaultId)) live.push(r);
  }
  if (live.length !== state.rounds.length) {
    state.rounds = live;
    saveLendingState(state);
  }
  return live;
}

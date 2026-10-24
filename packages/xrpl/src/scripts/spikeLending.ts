// Devnet lending spike: XLS-65 vault + XLS-66 loan with GPU shares escrowed
// as collateral. Uses fresh faucet wallets every run, prints addresses and tx
// hashes only (never seeds), and writes a summary to spike-devnet.json next to
// this script's package so docs/SPIKE_DEVNET_LENDING.md can cite real hashes.
//
// Run: npm run spike:lending -w packages/xrpl
// Optional: SPIKE_SKIP_DEFAULT=1 skips the ~3 minute default/liquidation leg.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  Wallet,
  BatchFlags,
  LoanManageFlags,
  LoanPayFlags,
  AccountSetAsfFlags,
  decode,
  signLoanSetByCounterparty,
  type SubmittableTransaction,
  type TxResponse,
  type LoanSet,
} from "xrpl";

const WSS = process.env.DEVNET_WSS || "wss://s.devnet.rippletest.net:51233";
const EXPLORER = "https://devnet.xrpl.org/transactions/";
const TF_INNER_BATCH_TXN = 0x40000000;
const SHARE_CODE = "GPA"; // 3-char share code for the spike

const summary: {
  network: string;
  startedAt: string;
  addresses: Record<string, string>;
  ids: Record<string, string | number>;
  steps: { step: string; result: string; hash?: string; note?: string }[];
  state: Record<string, unknown>;
} = { network: WSS, startedAt: new Date().toISOString(), addresses: {}, ids: {}, steps: [], state: {} };

function memo(type: string, data: Record<string, unknown>) {
  return [
    {
      Memo: {
        MemoType: Buffer.from("text/plain").toString("hex").toUpperCase(),
        MemoData: Buffer.from(JSON.stringify({ type, ...data })).toString("hex").toUpperCase(),
      },
    },
  ];
}

// Ledger Number fields can carry more digits than an IOU amount allows (15
// significant). Round UP to TDX's 6 decimals so a payment never falls short.
function ceil6(v: string | number): string {
  const s = /e/i.test(String(v)) ? Number(v).toFixed(18) : String(v);
  const [i, f = ""] = s.split(".");
  const head = BigInt(i + (f + "000000").slice(0, 6));
  const bump = /[1-9]/.test(f.slice(6)) ? 1n : 0n;
  const n = (head + bump).toString().padStart(7, "0");
  return `${n.slice(0, -6)}.${n.slice(-6)}`;
}

function resultOf(res: TxResponse): string {
  const meta = res.result.meta;
  return typeof meta === "object" && meta && "TransactionResult" in meta ? String(meta.TransactionResult) : "unknown";
}

function created(res: TxResponse, type: string): string | undefined {
  const meta = res.result.meta as any;
  return meta?.AffectedNodes?.find((n: any) => n.CreatedNode?.LedgerEntryType === type)?.CreatedNode?.LedgerIndex;
}

async function main() {
  const client = new Client(WSS);
  await client.connect();
  console.log(`Connected to ${WSS}`);

  async function submit(
    step: string,
    wallet: Wallet,
    tx: SubmittableTransaction,
    opts: { allowFail?: boolean } = {}
  ): Promise<TxResponse> {
    const prepared = await client.autofill({ ...tx, Account: tx.Account ?? wallet.address } as SubmittableTransaction);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const r = resultOf(res);
    summary.steps.push({ step, result: r, hash: res.result.hash });
    console.log(`${r === "tesSUCCESS" ? "ok  " : "FAIL"} ${step.padEnd(42)} ${r.padEnd(18)} ${EXPLORER}${res.result.hash}`);
    if (r !== "tesSUCCESS" && !opts.allowFail) throw new Error(`${step} failed: ${r}`);
    return res;
  }

  async function entry(index: string): Promise<any> {
    const res = await client.request({ command: "ledger_entry", index, ledger_index: "validated" } as any);
    return (res.result as any).node;
  }

  async function ledgerTime(): Promise<number> {
    const res = await client.request({ command: "ledger", ledger_index: "validated" });
    return res.result.ledger.close_time;
  }

  async function waitForLedgerTime(target: number, label: string) {
    process.stdout.write(`waiting for ${label}`);
    while ((await ledgerTime()) <= target) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 3000));
    }
    process.stdout.write("\n");
  }

  // 1. Fund fresh wallets from the devnet faucet (seeds stay in memory).
  const names = ["TDX_ISSUER", "SHARE_ISSUER", "BROKER", "LENDER", "ALICE"] as const;
  const w: Record<(typeof names)[number], Wallet> = {} as any;
  for (const n of names) {
    w[n] = (await client.fundWallet()).wallet;
    summary.addresses[n] = w[n].address;
    console.log(`funded ${n.padEnd(13)} ${w[n].address}`);
  }
  const TDX = (value: string) => ({ currency: "TDX", issuer: w.TDX_ISSUER.address, value });
  const SHARES = (value: string) => ({ currency: SHARE_CODE, issuer: w.SHARE_ISSUER.address, value });

  // 2. Issuer flags. DefaultRipple so holders can pay each other (and the
  // vault pseudo-account). AllowTrustLineLocking so shares can be escrowed.
  await submit("TDX_ISSUER DefaultRipple", w.TDX_ISSUER, { TransactionType: "AccountSet", SetFlag: AccountSetAsfFlags.asfDefaultRipple } as any);
  await submit("TDX_ISSUER AllowTrustLineLocking", w.TDX_ISSUER, { TransactionType: "AccountSet", SetFlag: 17 } as any);
  await submit("SHARE_ISSUER DefaultRipple", w.SHARE_ISSUER, { TransactionType: "AccountSet", SetFlag: AccountSetAsfFlags.asfDefaultRipple } as any);
  await submit("SHARE_ISSUER AllowTrustLineLocking", w.SHARE_ISSUER, { TransactionType: "AccountSet", SetFlag: 17 } as any);

  // 3. Trust lines and issuance.
  for (const n of ["BROKER", "LENDER", "ALICE"] as const) {
    await submit(`${n} trusts TDX`, w[n], { TransactionType: "TrustSet", LimitAmount: TDX("1000000000") } as any);
  }
  for (const n of ["BROKER", "ALICE"] as const) {
    await submit(`${n} trusts ${SHARE_CODE}`, w[n], { TransactionType: "TrustSet", LimitAmount: SHARES("1000") } as any);
  }
  await submit("issue 10000 TDX to LENDER", w.TDX_ISSUER, { TransactionType: "Payment", Destination: w.LENDER.address, Amount: TDX("10000") } as any);
  await submit("issue 1000 TDX to BROKER (cover)", w.TDX_ISSUER, { TransactionType: "Payment", Destination: w.BROKER.address, Amount: TDX("1000") } as any);
  await submit("issue 500 TDX to ALICE (interest)", w.TDX_ISSUER, { TransactionType: "Payment", Destination: w.ALICE.address, Amount: TDX("500") } as any);
  await submit(`issue 200 ${SHARE_CODE} shares to ALICE`, w.SHARE_ISSUER, { TransactionType: "Payment", Destination: w.ALICE.address, Amount: SHARES("200") } as any);

  // 4. XLS-65 vault holding the TDX IOU, owned by the broker account.
  // LendingProtocolV1_1 only lets a NEW loan broker sit on a closed-ended
  // vault (VaultKind 1). Phases: subscription (deposits) until
  // SubscriptionDate, investment (loans, no deposits or withdrawals) until
  // RedemptionDate, then redemption (withdrawals).
  const SUBSCRIPTION_SECONDS = Number(process.env.SPIKE_SUBSCRIPTION_SECONDS ?? 90);
  const subscriptionDate = (await ledgerTime()) + SUBSCRIPTION_SECONDS;
  const redemptionDate = subscriptionDate + 3600;
  summary.ids.subscriptionDate = subscriptionDate;
  summary.ids.redemptionDate = redemptionDate;
  const vaultRes = await submit("VaultCreate (TDX IOU, closed-ended)", w.BROKER, {
    TransactionType: "VaultCreate",
    Asset: { currency: "TDX", issuer: w.TDX_ISSUER.address },
    Data: Buffer.from("Moonshift GPU credit vault").toString("hex").toUpperCase(),
    VaultKind: 1,
    SubscriptionDate: subscriptionDate,
    RedemptionDate: redemptionDate,
  } as any);
  const vaultId = created(vaultRes, "Vault")!;
  summary.ids.vaultId = vaultId;

  await submit("LENDER VaultDeposit 5000 TDX", w.LENDER, { TransactionType: "VaultDeposit", VaultID: vaultId, Amount: TDX("5000") } as any);
  await submit("LENDER VaultWithdraw 50 TDX (subscription)", w.LENDER, { TransactionType: "VaultWithdraw", VaultID: vaultId, Amount: TDX("50") } as any, { allowFail: true });

  // 5. XLS-66 loan broker with first-loss cover. Rates are 1/10 bp units.
  const brokerRes = await submit("LoanBrokerSet", w.BROKER, {
    TransactionType: "LoanBrokerSet",
    VaultID: vaultId,
    ManagementFeeRate: 1000, // 1% of interest to the broker
    CoverRateMinimum: 10000, // cover must be >= 10% of debt
    CoverRateLiquidation: 50000, // up to 50% of minimum cover drawn on default
  } as any);
  const brokerId = created(brokerRes, "LoanBroker")!;
  summary.ids.loanBrokerId = brokerId;
  await submit("LoanBrokerCoverDeposit 200 TDX", w.BROKER, { TransactionType: "LoanBrokerCoverDeposit", LoanBrokerID: brokerId, Amount: TDX("200") } as any);

  // Loans can only be originated once the investment phase starts.
  await waitForLedgerTime(subscriptionDate, "investment phase");
  await submit("LENDER VaultDeposit 10 TDX (investment)", w.LENDER, { TransactionType: "VaultDeposit", VaultID: vaultId, Amount: TDX("10") } as any, { allowFail: true });

  // Collateral: borrower escrows GPU shares to the broker under a
  // PREIMAGE-SHA-256 condition only Moonshift knows. CancelAfter is the
  // borrower's safety valve if Moonshift disappears.
  async function lockCollateral(label: string, shares: string, loanRef: string) {
    const preimage = crypto.randomBytes(32);
    const hash = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase();
    const condition = "A0258020" + hash + "810120";
    const fulfillment = "A0228020" + preimage.toString("hex").toUpperCase();
    const res = await submit(`${label}: ALICE escrows ${shares} ${SHARE_CODE}`, w.ALICE, {
      TransactionType: "EscrowCreate",
      Destination: w.BROKER.address,
      Amount: SHARES(shares),
      Condition: condition,
      CancelAfter: (await ledgerTime()) + 24 * 3600,
      Memos: memo("MS_COLLATERAL", { loanRef }),
    } as any);
    return { condition, fulfillment, sequence: (res.result as any).tx_json?.Sequence as number, hash: res.result.hash };
  }

  async function openLoan(label: string, principal: string, opts: { total: number; interval: number; grace: number; ref: string }) {
    console.warn = () => {}; // autofill warns about LoanSet fee calc; harmless
    const prepared = (await client.autofill({
      TransactionType: "LoanSet",
      Account: w.BROKER.address,
      Counterparty: w.ALICE.address,
      LoanBrokerID: brokerId,
      PrincipalRequested: principal,
      InterestRate: 12000, // 12% APR in 1/10 bp
      PaymentTotal: opts.total,
      PaymentInterval: opts.interval,
      GracePeriod: opts.grace,
      Data: Buffer.from(opts.ref).toString("hex").toUpperCase(),
    } as LoanSet)) as LoanSet;
    const brokerSigned = decode(w.BROKER.sign(prepared).tx_blob) as unknown as LoanSet;
    const full = signLoanSetByCounterparty(w.ALICE, brokerSigned);
    const res = await client.submitAndWait(full.tx_blob);
    const r = resultOf(res);
    summary.steps.push({ step: `${label}: LoanSet (broker + ALICE countersign)`, result: r, hash: res.result.hash });
    console.log(`${r === "tesSUCCESS" ? "ok  " : "FAIL"} ${(label + ": LoanSet").padEnd(42)} ${r.padEnd(18)} ${EXPLORER}${res.result.hash}`);
    if (r !== "tesSUCCESS") throw new Error(`LoanSet failed: ${r}`);
    return created(res, "Loan")!;
  }

  // 6. Loan A: collateral, open, one scheduled payment, then full payoff.
  const colA = await lockCollateral("loan A", "100", "loanA");
  const loanA = await openLoan("loan A", "500", { total: 3, interval: 600, grace: 120, ref: `MS:escrow:${colA.sequence}` });
  summary.ids.loanA = loanA;
  let la = await entry(loanA);
  summary.state.loanA_opened = la;
  console.log(`loan A periodic=${la.PeriodicPayment} totalOutstanding=${la.TotalValueOutstanding} principal=${la.PrincipalOutstanding} remaining=${la.PaymentRemaining}`);

  await submit("loan A: ALICE LoanPay periodic", w.ALICE, { TransactionType: "LoanPay", LoanID: loanA, Amount: TDX(ceil6(la.PeriodicPayment)) } as any);
  la = await entry(loanA);
  summary.state.loanA_afterPay = la;
  console.log(`loan A after pay: totalOutstanding=${la.TotalValueOutstanding} remaining=${la.PaymentRemaining}`);

  // Margin call notice: an on-ledger memo from the broker to the borrower.
  await submit("margin call memo (1 drop to ALICE)", w.BROKER, {
    TransactionType: "Payment",
    Destination: w.ALICE.address,
    Amount: "1",
    Memos: memo("MS_MARGIN_CALL", { loanId: loanA, ltvBps: 6200, cureBy: new Date(Date.now() + 600000).toISOString() }),
  } as any);

  // Full payoff early.
  const payoff = await submit(
    "loan A: ALICE LoanPay full payoff",
    w.ALICE,
    { TransactionType: "LoanPay", LoanID: loanA, Amount: TDX(ceil6(la.TotalValueOutstanding)), Flags: LoanPayFlags.tfLoanFullPayment } as any,
    { allowFail: true }
  );
  if (resultOf(payoff) !== "tesSUCCESS") {
    for (let i = 0; i < 5; i++) {
      la = await entry(loanA).catch(() => null);
      if (!la || Number(la.PaymentRemaining) === 0) break;
      await submit(`loan A: ALICE LoanPay periodic #${i + 2}`, w.ALICE, { TransactionType: "LoanPay", LoanID: loanA, Amount: TDX(ceil6(la.PeriodicPayment)) } as any);
    }
  }
  la = await entry(loanA).catch(() => null);
  summary.state.loanA_afterPayoff = la;

  // Prompt release: broker finishes the escrow and returns the shares in one
  // all-or-nothing Batch, so the borrower never waits for CancelAfter.
  const releaseInner = [
    {
      TransactionType: "EscrowFinish",
      Account: w.BROKER.address,
      Owner: w.ALICE.address,
      OfferSequence: colA.sequence,
      Condition: colA.condition,
      Fulfillment: colA.fulfillment,
    },
    {
      TransactionType: "Payment",
      Account: w.BROKER.address,
      Destination: w.ALICE.address,
      Amount: SHARES("100"),
      Memos: memo("MS_COLLATERAL_RELEASE", { loanId: loanA }),
    },
  ].map((t) => ({ RawTransaction: { ...t, Flags: TF_INNER_BATCH_TXN, Fee: "0", SigningPubKey: "" } }));
  const batchPrepared = await client.autofill({ TransactionType: "Batch", Account: w.BROKER.address, Flags: BatchFlags.tfAllOrNothing, RawTransactions: releaseInner } as any);
  // EscrowFinish with a fulfillment costs more than the base fee.
  (batchPrepared as any).Fee = String(Number((batchPrepared as any).Fee) + 1000);
  const batchRes = await client.submitAndWait(w.BROKER.sign(batchPrepared).tx_blob);
  summary.steps.push({ step: "loan A: Batch(EscrowFinish + return shares)", result: resultOf(batchRes), hash: batchRes.result.hash });
  console.log(`${resultOf(batchRes) === "tesSUCCESS" ? "ok  " : "FAIL"} ${"loan A: Batch release collateral".padEnd(42)} ${resultOf(batchRes).padEnd(18)} ${EXPLORER}${batchRes.result.hash}`);
  if (resultOf(batchRes) !== "tesSUCCESS") {
    await submit("loan A: EscrowFinish (fallback)", w.BROKER, releaseInner[0].RawTransaction as any);
    await submit("loan A: return shares (fallback)", w.BROKER, releaseInner[1].RawTransaction as any);
  }

  if (la && Number(la.TotalValueOutstanding ?? 0) === 0) {
    await submit("loan A: LoanDelete", w.ALICE, { TransactionType: "LoanDelete", LoanID: loanA } as any, { allowFail: true });
  }

  // 7. Loan B: default path. Short interval and grace so it goes late fast.
  if (process.env.SPIKE_SKIP_DEFAULT !== "1") {
    const colB = await lockCollateral("loan B", "50", "loanB");
    const loanB = await openLoan("loan B", "300", { total: 1, interval: 60, grace: 60, ref: `MS:escrow:${colB.sequence}` });
    summary.ids.loanB = loanB;
    const lb = await entry(loanB);
    await waitForLedgerTime(lb.NextPaymentDueDate, "loan B payment due date");
    await submit("loan B: LoanManage impair", w.BROKER, { TransactionType: "LoanManage", LoanID: loanB, Flags: LoanManageFlags.tfLoanImpair } as any, { allowFail: true });
    await waitForLedgerTime(lb.NextPaymentDueDate + lb.GracePeriod, "loan B grace period");
    await submit("loan B: LoanManage default", w.BROKER, { TransactionType: "LoanManage", LoanID: loanB, Flags: LoanManageFlags.tfLoanDefault } as any, { allowFail: true });
    await submit("loan B: seize collateral (EscrowFinish)", w.BROKER, {
      TransactionType: "EscrowFinish",
      Owner: w.ALICE.address,
      OfferSequence: colB.sequence,
      Condition: colB.condition,
      Fulfillment: colB.fulfillment,
      Memos: memo("MS_LIQUIDATION", { loanId: loanB }),
    } as any);
    summary.state.loanB_afterDefault = await entry(loanB).catch((e) => `gone: ${e?.data?.error ?? e.message}`);
  }

  // 8. Lender withdraws part of the deposit. Read final vault + broker state.
  await submit("LENDER VaultWithdraw 100 TDX", w.LENDER, { TransactionType: "VaultWithdraw", VaultID: vaultId, Amount: TDX("100") } as any, { allowFail: true });
  summary.state.vault = await entry(vaultId);
  summary.state.loanBroker = await entry(brokerId);
  const v = summary.state.vault as any;
  const b = summary.state.loanBroker as any;
  console.log(`vault AssetsTotal=${v.AssetsTotal} AssetsAvailable=${v.AssetsAvailable} LossUnrealized=${v.LossUnrealized ?? 0}`);
  console.log(`broker DebtTotal=${b.DebtTotal ?? 0} CoverAvailable=${b.CoverAvailable ?? 0}`);

  const out = path.resolve(process.cwd(), "spike-devnet.json");
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log(`summary written to ${out}`);
  await client.disconnect();
}

main().catch((e) => {
  console.error("spike failed:", e.message);
  const out = path.resolve(process.cwd(), "spike-devnet.json");
  fs.writeFileSync(out, JSON.stringify({ ...summary, error: e.message }, null, 2) + "\n");
  process.exit(1);
});

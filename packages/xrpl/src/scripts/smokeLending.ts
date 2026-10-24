// Devnet lending smoke test: the full cycle against the setupNetwork world.
// deposit -> buy shares -> open loan (shares escrowed) -> pay installment ->
// margin call -> cure by prepayment -> pay off (collateral released, loan
// deleted) -> second loan -> margin call -> liquidate (seize) -> default once
// the ledger allows -> lender withdraws.
//
// Run: NETWORK=devnet npm run smoke:lending -w packages/xrpl
// Prints tx hashes only. Writes smoke-devnet.json (public data) for docs/DEMO.md.

import fs from "node:fs";
import path from "node:path";
import { networkInfo, txExplorerUrl, type TxResult } from "@moonshift/shared";
import { disconnectClient } from "../client.js";
import { getAccountAddress } from "../wallets.js";
import { buyShares } from "../dex.js";
import { getBalances } from "../balances.js";
import { currentRound, depositToVault, withdrawFromVault, getLoanBroker } from "../lending.js";
import {
  defaultLoan,
  getLedgerLoan,
  getVaultSummary,
  liquidateLoan,
  listLedgerLoans,
  marginCall,
  openLendingLoan,
  prepayLoan,
  repayLendingLoan,
} from "../lendingLoans.js";
import { ensureLendingRounds } from "../setup.js";

const steps: { step: string; result: string; hash: string; url: string }[] = [];
function rec(step: string, tx: TxResult | null | undefined) {
  if (!tx) {
    console.log(`--   ${step}`);
    return;
  }
  steps.push({ step, result: tx.result, hash: tx.hash, url: txExplorerUrl(tx.hash) });
  console.log(`${tx.result === "tesSUCCESS" ? "ok  " : "FAIL"} ${step.padEnd(46)} ${tx.result.padEnd(14)} ${tx.hash}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const net = networkInfo();
  if (!net.lending) throw new Error(`NETWORK=${net.name} has no XLS-66 lending. Run with NETWORK=devnet.`);
  console.log(`Lending smoke on ${net.name}`);
  await ensureLendingRounds();

  const investing = currentRound("investment");
  const subscribing = currentRound("subscription");
  if (!investing) throw new Error("No investing round");
  console.log(`investing round ${investing.round}, subscribing round ${subscribing?.round ?? "none"}`);

  // Lender deposits into the round that is open for deposits.
  if (subscribing) rec(`BOB deposits 100 TDX into round ${subscribing.round}`, await depositToVault({ lender: "BOB", vaultId: subscribing.vaultId, amount: "100" }));

  // Borrower buys GPU shares on the DEX to use as collateral.
  rec("ALICE buys 200 GPA on the DEX", await buyShares({ buyer: "ALICE", gpuId: "gpu-a", qty: "200", maxPricePerShare: "5.100000" }));
  const sharesBefore = (await getBalances("ALICE")).tokens["GPA"] ?? "0";
  console.log(`ALICE GPA before loans: ${sharesBefore}`);

  // Loan A: 100 TDX against 100 GPA (worth ~500 TDX), 5 x 120 s installments.
  const a = await openLendingLoan({
    borrower: "ALICE",
    gpuId: "gpu-a",
    collateralShares: "100",
    principal: "100",
    aprPct: 9.08,
    termSeconds: 600,
    paymentIntervalSeconds: 120,
    gracePeriodSeconds: 60,
  });
  rec("loan A: ALICE escrows 100 GPA (collateral)", a.escrowTx);
  rec("loan A: LoanSet (broker + ALICE countersign)", a.loanSetTx);
  console.log(`loan A ${a.loanId} periodic ${a.loan?.periodicPayment} owed ${a.loan?.totalValueOutstanding} due ${a.loan?.nextPaymentDueDate}`);

  const p1 = await repayLendingLoan({ loanId: a.loanId, mode: "next" });
  rec("loan A: ALICE pays one installment", p1.payments[0]);

  const mc = await marginCall({ loanId: a.loanId, observedLtv: "0.690000", threshold: "0.666048", reason: "SMOKE_TEST", cureBy: new Date(Date.now() + 600000).toISOString() });
  rec("loan A: margin call memo (MS_MARGIN_CALL)", mc.memoTx);

  try {
    rec("loan A: ALICE pays installment + 10 TDX principal (cure)", await prepayLoan({ loanId: a.loanId, extraPrincipal: "10" }));
  } catch (e) {
    console.log(`--   loan A prepay refused: ${(e as Error).message}`);
  }
  const midA = await getLedgerLoan(a.loanId);
  console.log(`loan A after cure: principal ${midA?.principalOutstanding} owed ${midA?.totalValueOutstanding} remaining ${midA?.paymentRemaining}`);

  const payoff = await repayLendingLoan({ loanId: a.loanId, mode: "full" });
  payoff.payments.forEach((t, i) => rec(`loan A: payoff LoanPay #${i + 1}`, t));
  rec("loan A: Batch release collateral to ALICE", payoff.releaseTx);
  rec("loan A: LoanDelete", payoff.deleteTx);
  const sharesAfter = (await getBalances("ALICE")).tokens["GPA"] ?? "0";
  console.log(`ALICE GPA after payoff: ${sharesAfter} (collateral back: ${Number(sharesAfter) === Number(sharesBefore)})`);

  // Loan B: liquidation path. Single 60 s payment so default comes quickly.
  const b = await openLendingLoan({
    borrower: "ALICE",
    gpuId: "gpu-a",
    collateralShares: "50",
    principal: "60",
    aprPct: 12,
    termSeconds: 60,
    paymentIntervalSeconds: 60,
    gracePeriodSeconds: 60,
  });
  rec("loan B: ALICE escrows 50 GPA", b.escrowTx);
  rec("loan B: LoanSet", b.loanSetTx);
  rec("loan B: margin call memo", (await marginCall({ loanId: b.loanId, observedLtv: "0.850000", threshold: "0.816048", reason: "SMOKE_TEST" })).memoTx);
  const liq = await liquidateLoan({ loanId: b.loanId, reason: "SMOKE_TEST_LIQUIDATION" });
  rec("loan B: seize collateral (MS_LIQUIDATION)", liq.seizeTx);
  console.log(`loan B default eligible at ${liq.defaultEligibleAt} (defaulted now: ${liq.defaulted})`);
  let defaultTx: TxResult | null = liq.defaultTx;
  for (let i = 0; !defaultTx && i < 60; i++) {
    await sleep(5000);
    defaultTx = await defaultLoan(b.loanId);
  }
  rec("loan B: LoanManage default", defaultTx);
  const lb = await getLedgerLoan(b.loanId);
  console.log(`loan B state ${lb?.state} collateral locked ${lb?.collateral?.locked}`);

  if (subscribing) rec(`BOB withdraws 50 TDX from round ${subscribing.round}`, await withdrawFromVault({ lender: "BOB", vaultId: subscribing.vaultId, amount: "50" }));

  const vault = await getVaultSummary(investing.vaultId);
  const broker = await getLoanBroker(investing.loanBrokerId);
  console.log(`vault round ${investing.round}: assets ${vault?.assetsTotal} available ${vault?.assetsAvailable} utilization ${vault?.utilizationPct}% lender APY ${vault?.lenderApyPct}%`);
  console.log(`broker: debt ${broker?.debtTotal} cover ${broker?.coverAvailable} loans originated ${broker?.loansOriginated}`);
  console.log(`loans on ledger now: ${(await listLedgerLoans()).length}`);

  const out = path.resolve(process.cwd(), "smoke-devnet.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        network: net.name,
        ranAt: new Date().toISOString(),
        borrower: getAccountAddress("ALICE"),
        broker: getAccountAddress("LENDING_POOL"),
        investingRound: investing.round,
        loanA: a.loanId,
        loanB: b.loanId,
        steps,
        vault,
        broker_state: broker,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`summary: ${out}`);
}

main()
  .catch((e) => {
    console.error("lending smoke failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectClient());

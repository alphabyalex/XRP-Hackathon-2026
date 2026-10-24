// npm run demo:reset: rebuild a clean devnet demo world in one command.
// 1. setupNetwork on devnet (tops wallets up from the faucet, rebuilds
//    anything missing after a devnet reset, keeps one investing and one
//    subscribing lending round).
// 2. Closes leftover open loans (pays them off, collateral released) so the
//    vault starts at 0% utilization.
// 3. Restores both GPU oracle prices to the opening NAV.
// 4. Makes sure ALICE holds GPU-A shares to pledge.
// 5. Clears the api's loan, quote and keeper tables (stop the api first if
//    you want a fully clean SSE stream; it is safe either way).
// Prints addresses and tx hashes only, never seeds.

process.env.NETWORK = "devnet";

const OPENING_NAV = "5.000000";
const ALICE_MIN_GPA = 300;

async function main() {
  const x = await import("@moonshift/xrpl");
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const path = await import("node:path");

  console.log("1/5 setupNetwork on devnet (faucet top-ups, lending rounds)...");
  await x.setupNetwork();

  console.log("2/5 closing leftover open loans...");
  for (const l of await x.listLedgerLoans()) {
    if (l.state === "defaulted" || Number(l.totalValueOutstanding) <= 0) continue;
    const who = x.accountNameFor(l.borrower);
    if (!who) {
      console.log(`  skip ${l.loanId.slice(0, 8)} (borrower ${l.borrower} not a demo account)`);
      continue;
    }
    try {
      const r = await x.repayLendingLoan({ loanId: l.loanId, mode: "full" });
      console.log(`  closed ${l.loanId.slice(0, 8)} (${who}) pay ${r.hash} release ${r.releaseTx?.hash ?? "-"}`);
    } catch (e) {
      // Past due: the ledger refuses a normal LoanPay (tecEXPIRED). Write it
      // off instead (its collateral is seized first if still locked).
      try {
        const r = await x.liquidateLoan({ loanId: l.loanId, reason: "DEMO_RESET" });
        console.log(`  wrote off ${l.loanId.slice(0, 8)} (${who}) seize ${r.seizeTx?.hash ?? "-"} default ${r.defaultTx?.hash ?? `after ${r.defaultEligibleAt}`}`);
      } catch (e2) {
        console.log(`  could not close ${l.loanId.slice(0, 8)}: ${(e as Error).message}; ${(e2 as Error).message}`);
      }
    }
  }

  console.log("3/5 restoring oracle prices...");
  for (const gpuId of ["gpu-a", "gpu-b"] as const) {
    const tx = await x.publishOracle({ gpuId, navPerShare: OPENING_NAV, gpuHourPrice: "3.000000", utilizationPct: "20.00" });
    console.log(`  ${gpuId} NAV ${OPENING_NAV} ${tx.hash}`);
  }

  console.log("4/5 borrower collateral...");
  const gpa = Number((await x.getBalances("ALICE")).tokens["GPA"] ?? 0);
  if (gpa < ALICE_MIN_GPA) {
    const tx = await x.buyShares({ buyer: "ALICE", gpuId: "gpu-a", qty: String(ALICE_MIN_GPA - gpa), maxPricePerShare: "5.100000" });
    console.log(`  ALICE bought ${ALICE_MIN_GPA - gpa} GPA ${tx.hash} (${tx.result})`);
  } else {
    console.log(`  ALICE holds ${gpa} GPA`);
  }

  console.log("5/5 clearing api lending tables...");
  const dbPath = path.join(process.cwd(), "apps", "api", "moonshift.db");
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    for (const t of ["xls_loans", "loan_quotes", "keeper_actions", "oracle_history", "credit_events"]) {
      try {
        db.exec(`DELETE FROM ${t}`);
      } catch {
        // table created on the api's next start
      }
    }
    db.close();
    console.log("  done");
  } else {
    console.log("  no api database yet (it is created on first start)");
  }

  const inv = x.currentRound("investment");
  const sub = x.currentRound("subscription");
  console.log(`\nDemo world ready on devnet. Investing round ${inv?.round ?? "none"}, subscribing round ${sub?.round ?? "none"}.`);
  console.log(`Borrower ALICE ${x.getAccountAddress("ALICE")}  Broker ${x.getAccountAddress("LENDING_POOL")}`);
  console.log("Start the demo with: npm run demo");
  await x.disconnectClient();
}

main().catch((e) => {
  console.error("demo-reset failed:", e?.message ?? e);
  process.exit(1);
});

// npm run demo:reset: rebuild a clean devnet demo world in one command.
// 1. setupNetwork on devnet (tops wallets up from the faucet, rebuilds
//    anything missing after a devnet reset, keeps one investing and one
//    subscribing lending round).
// 2. Closes leftover open loans (pays them off, collateral released) so the
//    vault starts at 0% utilization.
// 3. Restores both GPU oracle prices to the opening NAV.
// 4. Restocks the GPU-A share offer on the DEX, then tops every system
//    account up to 1,000 XRP from the faucet (setupNetwork tops TDX up: BOB
//    and CAROL 60,000 as background vault liquidity, DEV 15,000 for
//    demo:check; the subscribing round starts with BOB 20,000 + CAROL 1,000).
//    Users are their connected wallets: each gets its own account from the
//    api on first sign-in, so there is no borrower persona to prepare.
// 5. Clears the api's loan, quote and keeper tables (stop the api first if
//    you want a fully clean SSE stream; it is safe either way).
// Prints addresses and tx hashes only, never seeds.

process.env.NETWORK = "devnet";

const OPENING_NAV = "5.000000";
const XRP_TARGET = 1000;
const XRP_REFILL_BELOW = 900;

// Faucet top-ups (about 100 XRP per call on devnet) until each account
// holds XRP_TARGET. Accounts above XRP_REFILL_BELOW are left alone.
async function topUpXrp(x: typeof import("@moonshift/xrpl")) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const client = await x.getClient();
  const accounts = JSON.parse(fs.readFileSync(path.join(process.cwd(), "contracts", "accounts.devnet.json"), "utf8"));
  for (const name of Object.keys(accounts).filter((k) => !k.startsWith("_"))) {
    const wallet = x.getAccountWallet(name as any);
    const before = Number(await client.getXrpBalance(wallet.address).catch(() => "0"));
    let now = before;
    for (let i = 0; i < 15 && now < XRP_TARGET && before < XRP_REFILL_BELOW; i++) {
      try {
        await client.fundWallet(wallet);
      } catch (e) {
        console.log(`  faucet: ${name} ${(e as Error).message}`);
        break;
      }
      now = Number(await client.getXrpBalance(wallet.address));
    }
    console.log(`  ${name} ${wallet.address} XRP ${before.toFixed(2)} -> ${now.toFixed(2)}`);
  }
}

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

  console.log("4/5 market and balances...");
  const stock = await x.restockShares("gpu-a", OPENING_NAV);
  console.log(`  GPU-A shares: ${stock.returned} returned from the broker, ${stock.listed} re-listed by the treasury`);
  console.log(`  XRP top-ups to ${XRP_TARGET}...`);
  await topUpXrp(x);

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

  // Share books and the load simulator through the api if it is running
  // (npm run demo starts them otherwise). No history is generated.
  try {
    const key = process.env.INTERNAL_API_KEY || "moonshift-local-demo-key";
    const r = await fetch("http://localhost:4000/internal/seed-history", { method: "POST", headers: { "Content-Type": "application/json", "X-MS-Internal-Key": key } });
    console.log(r.ok ? "  market quoted through the api" : `  market quote: api answered ${r.status}`);
  } catch {
    console.log("  market quote: api not running; npm run demo quotes it on start");
  }

  const inv = x.currentRound("investment");
  const sub = x.currentRound("subscription");
  console.log(`\nDemo world ready on devnet. Investing round ${inv?.round ?? "none"}, subscribing round ${sub?.round ?? "none"}.`);
  console.log(`Broker ${x.getAccountAddress("LENDING_POOL")}`);
  console.log("Start the demo with: npm run demo");
  await x.disconnectClient();
}

main().catch((e) => {
  console.error("demo-reset failed:", e?.message ?? e);
  process.exit(1);
});

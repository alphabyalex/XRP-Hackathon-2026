import {
  setupNetwork,
  getBalances,
  getHolders,
  buyShares,
  buyContracts,
  redeemContracts,
  payForInference,
  payDividends,
  openLoan,
  repayLoan,
  settleLoan,
  publishOracle,
  disconnectClient,
  getAccountAddress,
} from "../index.js";

async function main() {
  console.log("==================================================================");
  console.log("              MOONSHIFT XRPL ON-CHAIN SMOKE TEST                  ");
  console.log("==================================================================\n");

  try {
    // 1. Setup Network (idempotent)
    console.log("--- 1. Initializing Network State ---");
    const accounts = await setupNetwork();
    console.log("Network state ready.");

    // 2. Buy Shares (Alice buys 50 shares of GPU A)
    console.log("\n--- 2. Buy Shares (Alice buys 50 shares of GPU A) ---");
    const buySharesTx = await buyShares({
      buyer: "ALICE",
      gpuId: "gpu-a",
      qty: "50",
      maxPricePerShare: "10",
    });
    console.log(`Hash: ${buySharesTx.hash}`);
    console.log(`Result: ${buySharesTx.result}`);
    console.log(`Explorer: ${buySharesTx.explorerUrl}`);

    const holders = await getHolders("gpu-a");
    console.log("Current GPU A Holders:", JSON.stringify(holders));

    // 3. Buy Contracts (DEV buys 2 contracts of GPU A)
    console.log("\n--- 3. Buy Contracts (DEV buys 2 contracts of GPU A) ---");
    const buyContractsTx = await buyContracts({
      buyer: "DEV",
      gpuId: "gpu-a",
      qty: "2",
      maxPrice: "1",
    });
    console.log(`Hash: ${buyContractsTx.hash}`);
    console.log(`Result: ${buyContractsTx.result}`);
    console.log(`Explorer: ${buyContractsTx.explorerUrl}`);

    // 4. Redeem Contracts (DEV redeems 1 contract of GPU A)
    console.log("\n--- 4. Redeem Contracts (DEV redeems 1 contract of GPU A) ---");
    const slotStart = new Date().toISOString();
    const redeemTx = await redeemContracts({
      holder: "DEV",
      gpuId: "gpu-a",
      qty: "1",
      slotStart,
    });
    console.log(`Hash: ${redeemTx.hash}`);
    console.log(`Redemption ID: ${redeemTx.redemptionId}`);
    console.log(`Result: ${redeemTx.result}`);
    console.log(`Explorer: ${redeemTx.explorerUrl}`);

    // 5. Pay for Inference (DEV prepays TDX credits)
    console.log("\n--- 5. Pay for Inference Credits (DEV prepays 5 TDX) ---");
    const payInferenceTx = await payForInference({
      payer: "DEV",
      gpuId: "gpu-a",
      amount: "5.000000",
      memo: "Prepay 5 TDX compute credits",
    });
    console.log(`Hash: ${payInferenceTx.hash}`);
    console.log(`Result: ${payInferenceTx.result}`);
    console.log(`Explorer: ${payInferenceTx.explorerUrl}`);

    // 6. Pay Dividends (Batch / Sequential payout to shareholders)
    console.log("\n--- 6. Pay Dividends (Treasury -> Protocol fees + Shareholders) ---");
    const aliceAddress = getAccountAddress("ALICE");
    const dividendTxs = await payDividends({
      gpuId: "gpu-a",
      hostingFee: "0.500000",
      payouts: [
        {
          account: aliceAddress,
          amount: "1.500000",
        },
      ],
    });
    for (let i = 0; i < dividendTxs.length; i++) {
      const tx = dividendTxs[i];
      console.log(`Dividend Tx ${i + 1} Hash: ${tx.hash}`);
      console.log(`Result: ${tx.result}`);
      console.log(`Explorer: ${tx.explorerUrl}`);
    }

    // 7. Publish Oracle
    console.log("\n--- 7. Publish Price & Telemetry Oracle ---");
    const oracleTx = await publishOracle({
      gpuId: "gpu-a",
      navPerShare: "5.250000",
      gpuHourPrice: "0.300000",
      utilizationPct: "82.500000",
    });
    console.log(`Oracle Hash: ${oracleTx.hash}`);
    console.log(`Result: ${oracleTx.result}`);
    console.log(`Explorer: ${oracleTx.explorerUrl}`);

    // 8. Loan Cycle 1 (Open -> Repay)
    console.log("\n--- 8. Loan Cycle 1: Open and Repay (Alice escrows 10 shares) ---");
    const dueAt1 = new Date(Date.now() + 60000).toISOString();
    const loan1 = await openLoan({
      borrower: "ALICE",
      gpuId: "gpu-a",
      collateralShares: "10",
      principal: "25.000000",
      dueAt: dueAt1,
    });
    console.log(`Loan 1 ID: ${loan1.loanId}`);
    console.log(`Escrow Tx: ${loan1.escrowTx.hash} (${loan1.escrowTx.result})`);
    console.log(`  Explorer: ${loan1.escrowTx.explorerUrl}`);
    console.log(`Disburse Tx: ${loan1.disburseTx.hash} (${loan1.disburseTx.result})`);
    console.log(`  Explorer: ${loan1.disburseTx.explorerUrl}`);

    const repayTx = await repayLoan({ loanId: loan1.loanId });
    console.log(`Repay Tx: ${repayTx.hash} (${repayTx.result})`);
    console.log(`  Explorer: ${repayTx.explorerUrl}`);

    // 9. Loan Cycle 2 (Open -> Default -> Settle via EscrowFinish)
    console.log("\n--- 9. Loan Cycle 2: Open and Default (Bob escrows 10 shares) ---");
    // Ensure Bob has shares first
    await buyShares({
      buyer: "BOB",
      gpuId: "gpu-a",
      qty: "20",
      maxPricePerShare: "10",
    });

    const dueAt2 = new Date(Date.now() + 60000).toISOString();
    const loan2 = await openLoan({
      borrower: "BOB",
      gpuId: "gpu-a",
      collateralShares: "10",
      principal: "25.000000",
      dueAt: dueAt2,
    });
    console.log(`Loan 2 ID: ${loan2.loanId}`);
    console.log(`Escrow Tx: ${loan2.escrowTx.hash} (${loan2.escrowTx.result})`);
    console.log(`  Explorer: ${loan2.escrowTx.explorerUrl}`);
    console.log(`Disburse Tx: ${loan2.disburseTx.hash} (${loan2.disburseTx.result})`);
    console.log(`  Explorer: ${loan2.disburseTx.explorerUrl}`);

    console.log("Triggering default settlement (EscrowFinish with crypto-condition fulfillment)...");
    const settleDefaultTx = await settleLoan({ loanId: loan2.loanId });
    console.log(`Settle Default Tx: ${settleDefaultTx.hash} (${settleDefaultTx.result})`);
    console.log(`  Explorer: ${settleDefaultTx.explorerUrl}`);

    // Check balances
    console.log("\n--- 10. Final Account Balances Summary ---");
    const aliceBal = await getBalances("ALICE");
    const bobBal = await getBalances("BOB");
    const devBal = await getBalances("DEV");
    console.log("Alice:", JSON.stringify(aliceBal));
    console.log("Bob:", JSON.stringify(bobBal));
    console.log("Dev:", JSON.stringify(devBal));

    console.log("\n==================================================================");
    console.log("       ALL ON-CHAIN SMOKE TESTS COMPLETED SUCCESSFULLY!           ");
    console.log("==================================================================");
  } catch (err) {
    console.error("Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    await disconnectClient();
  }
}

main();

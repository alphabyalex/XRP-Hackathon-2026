import { BatchFlags, type Batch, type Payment } from "xrpl";
import type { PayDividendsParams, TxResult } from "@moonshift/shared";
import { getClient, submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";
import { checkFeatures } from "./features.js";

const TF_INNER_BATCH_TXN = 0x40000000;

export async function payDividends(p: PayDividendsParams): Promise<TxResult[]> {
  const treasuryAccount = p.gpuId === "gpu-a" ? "TREASURY_GPU_A" : "TREASURY_GPU_B";
  const treasuryWallet = getAccountWallet(treasuryAccount);
  const protocolFeesAddress = getAccountAddress("PROTOCOL_FEES");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const runRef = `div_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Assemble all payment targets
  interface PaymentItem {
    destination: string;
    amount: string;
    memoType: string;
  }

  const items: PaymentItem[] = [];

  // 1. Hosting fee to PROTOCOL_FEES
  if (Number(p.hostingFee) > 0) {
    items.push({
      destination: protocolFeesAddress,
      amount: p.hostingFee,
      memoType: "GB_HOSTING_FEE",
    });
  }

  // 2. Shareholder payouts
  for (const payout of p.payouts) {
    if (Number(payout.amount) > 0) {
      items.push({
        destination: payout.account,
        amount: payout.amount,
        memoType: "GB_DIVIDEND",
      });
    }
  }

  if (items.length === 0) {
    return [];
  }

  // Check if BatchV1_1 is enabled on network
  let useBatch = false;
  try {
    const report = await checkFeatures();
    useBatch = Boolean(report.features.BatchV1_1?.enabled);
  } catch {
    useBatch = false;
  }

  const results: TxResult[] = [];

  if (useBatch) {
    try {
      // Split into batches of up to 8 inner transactions
      const batchSize = 8;
      for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize);

        const rawTransactions = chunk.map((item) => {
          const innerPayment: Payment = {
            TransactionType: "Payment",
            Account: treasuryWallet.address,
            Destination: item.destination,
            Amount: {
              currency: "TDX",
              issuer: tdxIssuer,
              value: item.amount,
            },
            Flags: TF_INNER_BATCH_TXN,
            Fee: "0",
            SigningPubKey: "",
            Memos: [
              {
                Memo: {
                  MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
                  MemoData: Buffer.from(
                    JSON.stringify({ type: item.memoType, runRef, amount: item.amount }),
                    "utf8"
                  )
                    .toString("hex")
                    .toUpperCase(),
                },
              },
            ],
          };

          return { RawTransaction: innerPayment };
        });

        const batchTx: Batch = {
          TransactionType: "Batch",
          Account: treasuryWallet.address,
          Flags: BatchFlags.tfAllOrNothing,
          RawTransactions: rawTransactions,
        };

        const txResult = await submitTx(treasuryWallet, batchTx);
        results.push(txResult);
      }

      return results;
    } catch (batchErr) {
      console.warn("Batch payment failed or rejected, falling back to sequential payments:", (batchErr as Error).message);
    }
  }

  // Fallback: Sequential Payments
  for (const item of items) {
    const payment: Payment = {
      TransactionType: "Payment",
      Account: treasuryWallet.address,
      Destination: item.destination,
      Amount: {
        currency: "TDX",
        issuer: tdxIssuer,
        value: item.amount,
      },
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
            MemoData: Buffer.from(
              JSON.stringify({ type: item.memoType, runRef, amount: item.amount }),
              "utf8"
            )
              .toString("hex")
              .toUpperCase(),
          },
        },
      ],
    };

    const res = await submitTx(treasuryWallet, payment);
    results.push(res);
  }

  return results;
}

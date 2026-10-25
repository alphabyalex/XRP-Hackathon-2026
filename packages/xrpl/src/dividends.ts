import { BatchFlags, type Batch, type Payment } from "xrpl";
import { treasuryOf, type PayDividendsParams, type TxResult } from "@moonshift/shared";
import { getClient, submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";
import { checkFeatures } from "./features.js";

const TF_INNER_BATCH_TXN = 0x40000000;

export async function payDividends(p: PayDividendsParams): Promise<TxResult[]> {
  const treasuryAccount = treasuryOf(p.gpuId);
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

  // 1. Shareholder payouts first
  for (const payout of p.payouts) {
    if (Number(payout.amount) > 0) {
      items.push({
        destination: payout.account,
        amount: payout.amount,
        memoType: "MS_DIVIDEND",
      });
    }
  }

  // 2. Hosting fee to PROTOCOL_FEES last
  if (Number(p.hostingFee) > 0) {
    items.push({
      destination: protocolFeesAddress,
      amount: p.hostingFee,
      memoType: "MS_HOSTING_FEE",
    });
  }

  if (items.length === 0) {
    const noopResult: TxResult = {
      hash: "ZERO_PAYOUT_NOOP",
      result: "tesSUCCESS",
      validated: true,
      explorerUrl: "",
    };
    const zeroResults: TxResult[] = p.payouts.map(() => noopResult);
    zeroResults.push(noopResult);
    return zeroResults;
  }

  // Check if BatchV1_1 is enabled on network
  let useBatch = false;
  try {
    const report = await checkFeatures();
    useBatch = Boolean(report.features.BatchV1_1?.enabled);
  } catch {
    useBatch = false;
  }

  if (useBatch) {
    try {
      // Split into batches of up to 8 inner transactions
      const batchSize = 8;
      let lastBatchResult: TxResult | null = null;
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

        lastBatchResult = await submitTx(treasuryWallet, batchTx);
      }

      if (lastBatchResult) {
        // Return 1:1 TxResult for each payout, plus 1 for the hosting fee
        const results: TxResult[] = p.payouts.map(() => lastBatchResult!);
        results.push(lastBatchResult);
        return results;
      }
    } catch (batchErr) {
      console.warn("Batch payment failed or rejected, falling back to sequential payments:", (batchErr as Error).message);
    }
  }

  // Fallback: Sequential Payments
  const results: TxResult[] = [];
  for (const payout of p.payouts) {
    if (Number(payout.amount) <= 0) {
      results.push({
        hash: "ZERO_PAYOUT_NOOP",
        result: "tesSUCCESS",
        validated: true,
        explorerUrl: "",
      });
      continue;
    }
    const payment: Payment = {
      TransactionType: "Payment",
      Account: treasuryWallet.address,
      Destination: payout.account,
      Amount: {
        currency: "TDX",
        issuer: tdxIssuer,
        value: payout.amount,
      },
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
            MemoData: Buffer.from(
              JSON.stringify({ type: "MS_DIVIDEND", runRef, amount: payout.amount }),
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

  if (Number(p.hostingFee) > 0) {
    const feePayment: Payment = {
      TransactionType: "Payment",
      Account: treasuryWallet.address,
      Destination: protocolFeesAddress,
      Amount: {
        currency: "TDX",
        issuer: tdxIssuer,
        value: p.hostingFee,
      },
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
            MemoData: Buffer.from(
              JSON.stringify({ type: "MS_HOSTING_FEE", runRef, amount: p.hostingFee }),
              "utf8"
            )
              .toString("hex")
              .toUpperCase(),
          },
        },
      ],
    };
    const feeRes = await submitTx(treasuryWallet, feePayment);
    results.push(feeRes);
  } else {
    results.push({
      hash: "ZERO_PAYOUT_NOOP",
      result: "tesSUCCESS",
      validated: true,
      explorerUrl: "",
    });
  }

  return results;
}

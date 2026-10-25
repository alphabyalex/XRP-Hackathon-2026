import { treasuryOf, type PayForInferenceParams, type TxResult } from "@moonshift/shared";
import type { Payment } from "xrpl";
import { submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";

export async function payForInference(p: PayForInferenceParams): Promise<TxResult> {
  const payerWallet = getAccountWallet(p.payer);
  const treasuryAccount = treasuryOf(p.gpuId);
  const treasuryAddress = getAccountAddress(treasuryAccount);
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const memoData = JSON.stringify({
    type: "MS_CREDITS",
    gpuId: p.gpuId,
    note: p.memo,
  });

  const payment: Payment = {
    TransactionType: "Payment",
    Account: payerWallet.address,
    Destination: treasuryAddress,
    Amount: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: p.amount,
    },
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(memoData, "utf8").toString("hex").toUpperCase(),
        },
      },
    ],
  };

  return submitTx(payerWallet, payment);
}

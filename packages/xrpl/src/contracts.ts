import { GPUS } from "@moonshift/shared";
import type { RedeemContractsParams, RedeemContractsResult } from "@moonshift/shared";
import type { Payment } from "xrpl";
import { submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";

export async function redeemContracts(
  p: RedeemContractsParams
): Promise<RedeemContractsResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const holderWallet = getAccountWallet(p.holder);
  const contractIssuer = getAccountAddress("CONTRACT_ISSUER");

  const memoData = JSON.stringify({
    type: "GB_REDEEM",
    gpuId: p.gpuId,
    slotStart: p.slotStart,
    slots: p.qty,
  });

  const payment: Payment = {
    TransactionType: "Payment",
    Account: holderWallet.address,
    Destination: contractIssuer,
    Amount: {
      currency: gpu.contractCode,
      issuer: contractIssuer,
      value: p.qty,
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

  const txResult = await submitTx(holderWallet, payment);
  return {
    ...txResult,
    redemptionId: txResult.hash,
  };
}

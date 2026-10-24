import {
  xrpToDrops,
  signPaymentChannelClaim,
  verifyPaymentChannelClaim,
  type PaymentChannelCreate,
  type PaymentChannelClaim,
} from "xrpl";
import type { AccountName, TxResult } from "@moonshift/shared";
import { submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";

export interface ChannelInfo {
  channelId: string;
  createTx: TxResult;
}

export async function createPaymentChannel(
  payer: AccountName,
  destination: AccountName,
  amountXrp: string,
  settleDelay = 86400
): Promise<ChannelInfo> {
  const payerWallet = getAccountWallet(payer);
  const destAddress = getAccountAddress(destination);

  const tx: PaymentChannelCreate = {
    TransactionType: "PaymentChannelCreate",
    Account: payerWallet.address,
    Destination: destAddress,
    Amount: xrpToDrops(amountXrp),
    SettleDelay: settleDelay,
    PublicKey: payerWallet.publicKey,
  };

  const createTx = await submitTx(payerWallet, tx);
  const meta: any = (createTx as any).meta;
  let channelId = "";

  if (meta && Array.isArray(meta.AffectedNodes)) {
    const createdNode = meta.AffectedNodes.find(
      (n: any) => n.CreatedNode?.LedgerEntryType === "PayChannel"
    );
    if (createdNode) {
      channelId = createdNode.CreatedNode.LedgerIndex;
    }
  }

  return { channelId, createTx };
}

export function signChannelClaim(
  channelId: string,
  amountXrp: string,
  privateKey: string
): string {
  return signPaymentChannelClaim(channelId, amountXrp, privateKey);
}

export function verifyChannelClaim(
  channelId: string,
  amountXrp: string,
  signature: string,
  publicKey: string
): boolean {
  return verifyPaymentChannelClaim(channelId, amountXrp, signature, publicKey);
}

export async function claimPaymentChannel(
  receiver: AccountName,
  channelId: string,
  cumulativeAmountXrp: string,
  signature: string,
  publicKey: string
): Promise<TxResult> {
  const receiverWallet = getAccountWallet(receiver);

  const tx: PaymentChannelClaim = {
    TransactionType: "PaymentChannelClaim",
    Account: receiverWallet.address,
    Channel: channelId,
    Balance: xrpToDrops(cumulativeAmountXrp),
    Signature: signature,
    PublicKey: publicKey,
  };

  return submitTx(receiverWallet, tx);
}

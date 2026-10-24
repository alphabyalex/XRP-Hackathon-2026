// GPU-share collateral: our layer on top of XLS-66, which has no collateral
// concept. The borrower escrows shares to the Moonshift broker under a
// PREIMAGE-SHA-256 condition.
//
// The preimage is HMAC(broker private key, nonce) and the nonce is public
// (escrow memo + LoanSet Data). So only the broker can finish the escrow, and
// nothing secret has to be stored: every loan can be rebuilt from the ledger.
//
// Repay: one all-or-nothing Batch from the broker does EscrowFinish (shares to
// the broker) + Payment (shares back to the borrower). The borrower is whole
// in the same ledger and never waits for CancelAfter. Tradeoff: the borrower
// trusts Moonshift to submit the release; CancelAfter caps that trust in time,
// since after it the borrower can cancel the escrow alone. Escrowing to the
// borrower instead would make seizure on default impossible.

import crypto from "node:crypto";
import { BatchFlags, type Wallet } from "xrpl";
import { GPUS, fix6, type CollateralLock, type GpuId, type TxResult } from "@moonshift/shared";
import { getClient, ledgerCloseTime, submitTx, submitTxFull } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";
import { BROKER_ACCOUNT, must } from "./lending.js";

const TF_INNER_BATCH_TXN = 0x40000000;

export function memo(type: string, data: Record<string, unknown>) {
  return [
    {
      Memo: {
        MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
        MemoData: Buffer.from(JSON.stringify({ type, ...data }), "utf8").toString("hex").toUpperCase(),
      },
    },
  ];
}

export function decodeMemos(tx: any): Record<string, any>[] {
  return (tx?.Memos ?? [])
    .map((m: any) => {
      try {
        return JSON.parse(Buffer.from(m.Memo.MemoData, "hex").toString("utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function shareAmount(gpuId: GpuId, value: string) {
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${gpuId}`);
  return { currency: gpu.shareCode, issuer: getAccountAddress("SHARE_ISSUER"), value: fix6(value) };
}

export function newNonce(): string {
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

// Condition and fulfillment for a nonce, derived from the broker's key.
export function conditionFor(nonce: string, broker: Wallet = getAccountWallet(BROKER_ACCOUNT)) {
  const preimage = crypto.createHmac("sha256", broker.privateKey).update(`moonshift-collateral:${nonce}`).digest();
  const digest = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return {
    condition: "A0258020" + digest + "810120",
    fulfillment: "A0228020" + preimage.toString("hex").toUpperCase(),
  };
}

export interface LockCollateralParams {
  borrower: Wallet;
  gpuId: GpuId;
  shares: string;
  nonce: string;
  cancelAfterSeconds: number; // borrower's safety valve, from now
}

export async function lockCollateral(p: LockCollateralParams): Promise<{ tx: TxResult; escrowSequence: number }> {
  const broker = getAccountAddress(BROKER_ACCOUNT);
  const { condition } = conditionFor(p.nonce);
  const { txResult } = await submitTxFull(p.borrower, {
    TransactionType: "EscrowCreate",
    Account: p.borrower.address,
    Destination: broker,
    Amount: shareAmount(p.gpuId, p.shares),
    Condition: condition,
    CancelAfter: (await ledgerCloseTime()) + Math.max(600, Math.floor(p.cancelAfterSeconds)),
    Memos: memo("MS_COLLATERAL", { nonce: p.nonce, gpuId: p.gpuId, shares: fix6(p.shares) }),
  } as any);
  must(txResult, "EscrowCreate (collateral)");
  if (typeof txResult.sequence !== "number") throw new Error(`No escrow sequence on ${txResult.hash}`);
  return { tx: txResult, escrowSequence: txResult.sequence };
}

// Is the escrow still on ledger?
export async function escrowExists(owner: string, sequence: number): Promise<boolean> {
  const client = await getClient();
  try {
    await client.request({ command: "ledger_entry", escrow: { owner, seq: sequence }, ledger_index: "validated" } as any);
    return true;
  } catch {
    return false;
  }
}

export interface EscrowKeys {
  condition: string;
  fulfillment: string;
}

function finishTx(lock: CollateralLock, brokerAddress: string, memoType: string, loanId: string, keys?: EscrowKeys) {
  const { condition, fulfillment } = keys ?? conditionFor(lock.nonce);
  return {
    TransactionType: "EscrowFinish",
    Account: brokerAddress,
    Owner: lock.owner,
    OfferSequence: lock.escrowSequence,
    Condition: condition,
    Fulfillment: fulfillment,
    Memos: memo(memoType, { loanId, nonce: lock.nonce }),
  };
}

// Repaid: finish the escrow and hand the shares straight back, atomically.
// Falls back to two plain transactions if the network rejects the Batch.
// `keys` is only for legacy testnet escrows that stored their own condition.
export async function releaseCollateral(lock: CollateralLock, loanId: string, keys?: EscrowKeys): Promise<TxResult> {
  const broker = getAccountWallet(BROKER_ACCOUNT);
  const inner = [
    finishTx(lock, broker.address, "MS_COLLATERAL_RELEASE", loanId, keys),
    {
      TransactionType: "Payment",
      Account: broker.address,
      Destination: lock.owner,
      Amount: shareAmount(lock.gpuId as GpuId, lock.shares),
      Memos: memo("MS_COLLATERAL_RELEASE", { loanId, nonce: lock.nonce }),
    },
  ];
  const client = await getClient();
  const batch: any = await client.autofill({
    TransactionType: "Batch",
    Account: broker.address,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: inner.map((t) => ({ RawTransaction: { ...t, Flags: TF_INNER_BATCH_TXN, Fee: "0", SigningPubKey: "" } })),
  } as any);
  // EscrowFinish with a fulfillment costs more than the base fee.
  batch.Fee = String(Number(batch.Fee) + 1000);
  const { txResult } = await submitTxFull(broker, batch, { autofill: false });
  if (txResult.result === "tesSUCCESS") return txResult;

  must(await submitTx(broker, inner[0] as any), "EscrowFinish (release)");
  return must(await submitTx(broker, inner[1] as any), "return collateral");
}

// Liquidation or default: finish the escrow and keep the shares.
export async function seizeCollateral(lock: CollateralLock, loanId: string, reason: string, keys?: EscrowKeys): Promise<TxResult> {
  const broker = getAccountWallet(BROKER_ACCOUNT);
  const tx = { ...finishTx(lock, broker.address, "MS_LIQUIDATION", loanId, keys) };
  tx.Memos = memo("MS_LIQUIDATION", { loanId, nonce: lock.nonce, reason });
  return must(await submitTx(broker, tx as any), "EscrowFinish (seize collateral)");
}

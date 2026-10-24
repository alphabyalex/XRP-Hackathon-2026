import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isoTimeToRippleTime,
  type EscrowCreate,
  type EscrowFinish,
  type EscrowCancel,
  type Payment,
} from "xrpl";
import { GPUS } from "@moonshift/shared";
import type { OpenLoanParams, OpenLoanResult, TxResult } from "@moonshift/shared";
import { getClient, submitTx } from "./client.js";
import {
  getAccountAddress,
  getAccountWallet,
  REPO_ROOT,
} from "./wallets.js";
import { LedgerRejected } from "./errors.js";

const LOANS_STORE_PATH = path.join(REPO_ROOT, "contracts", "active_loans.json");

export interface StoredLoan {
  loanId: string;
  borrower: string;
  borrowerAddress: string;
  gpuId: string;
  collateralShares: string;
  principal: string;
  dueAt: string;
  condition: string;
  fulfillment: string;
  escrowSequence: number;
  repaid: boolean;
  settled: boolean;
}

function loadLoansRegistry(): Record<string, StoredLoan> {
  if (fs.existsSync(LOANS_STORE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(LOANS_STORE_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveLoansRegistry(registry: Record<string, StoredLoan>): void {
  const dir = path.dirname(LOANS_STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOANS_STORE_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

export async function openLoan(p: OpenLoanParams): Promise<OpenLoanResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const borrowerWallet = getAccountWallet(p.borrower);
  const lendingPoolWallet = getAccountWallet("LENDING_POOL");
  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  // 1. Generate 32-byte preimage and crypto-condition
  const preimage = crypto.randomBytes(32);
  const sha256 = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase();
  const condition = "A0258020" + sha256 + "810120";
  const fulfillment = "A0228020" + preimage.toString("hex").toUpperCase();

  // CancelAfter = dueAt + 2 minutes grace period (in Ripple Epoch seconds)
  const dueAtSeconds = Math.floor(new Date(p.dueAt).getTime() / 1000);
  const cancelAfterRippleTime = dueAtSeconds - 946684800 + 120;

  // 2. Borrower locks collateral in Escrow to LENDING_POOL
  const escrowTxPayload: EscrowCreate = {
    TransactionType: "EscrowCreate",
    Account: borrowerWallet.address,
    Destination: lendingPoolWallet.address,
    Amount: {
      currency: gpu.shareCode,
      issuer: shareIssuer,
      value: p.collateralShares,
    },
    Condition: condition,
    CancelAfter: cancelAfterRippleTime,
  };

  const escrowTx = await submitTx(borrowerWallet, escrowTxPayload);
  const escrowSequence = (escrowTx as any).sequence;
  if (typeof escrowSequence !== "number") {
    throw new Error(`Failed to retrieve escrow sequence number from tx: ${escrowTx.hash}`);
  }

  // 3. LENDING_POOL pays principal in TDX to borrower
  const disburseTxPayload: Payment = {
    TransactionType: "Payment",
    Account: lendingPoolWallet.address,
    Destination: borrowerWallet.address,
    Amount: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: p.principal,
    },
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(
            JSON.stringify({ type: "MS_LOAN_DISBURSE", loanId: escrowTx.hash }),
            "utf8"
          )
            .toString("hex")
            .toUpperCase(),
        },
      },
    ],
  };

  const disburseTx = await submitTx(lendingPoolWallet, disburseTxPayload);

  // 4. Save to registry
  const registry = loadLoansRegistry();
  registry[escrowTx.hash] = {
    loanId: escrowTx.hash,
    borrower: p.borrower,
    borrowerAddress: borrowerWallet.address,
    gpuId: p.gpuId,
    collateralShares: p.collateralShares,
    principal: p.principal,
    dueAt: p.dueAt,
    condition,
    fulfillment,
    escrowSequence,
    repaid: false,
    settled: false,
  };
  saveLoansRegistry(registry);

  return {
    loanId: escrowTx.hash,
    escrowTx,
    disburseTx,
  };
}

export async function repayLoan(p: { loanId: string }): Promise<TxResult> {
  const registry = loadLoansRegistry();
  const loan = registry[p.loanId];
  if (!loan) {
    throw new Error(`Unknown loanId: ${p.loanId}`);
  }

  const borrowerWallet = getAccountWallet(loan.borrower as any);
  const lendingPoolAddress = getAccountAddress("LENDING_POOL");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const payment: Payment = {
    TransactionType: "Payment",
    Account: borrowerWallet.address,
    Destination: lendingPoolAddress,
    Amount: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: loan.principal,
    },
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(
            JSON.stringify({ type: "MS_REPAY", loanId: p.loanId }),
            "utf8"
          )
            .toString("hex")
            .toUpperCase(),
        },
      },
    ],
  };

  const txResult = await submitTx(borrowerWallet, payment);
  loan.repaid = true;
  saveLoansRegistry(registry);

  return txResult;
}

export async function settleLoan(p: { loanId: string }): Promise<TxResult> {
  const registry = loadLoansRegistry();
  const loan = registry[p.loanId];
  if (!loan) {
    throw new Error(`Unknown loanId: ${p.loanId}`);
  }

  const lendingPoolWallet = getAccountWallet("LENDING_POOL");

  if (loan.repaid) {
    // EscrowCancel: Return shares to borrower (after CancelAfter expires)
    const borrowerWallet = getAccountWallet(loan.borrower as any);
    const cancelTx: EscrowCancel = {
      TransactionType: "EscrowCancel",
      Account: borrowerWallet.address,
      Owner: loan.borrowerAddress,
      OfferSequence: loan.escrowSequence,
    };

    const res = await submitTx(borrowerWallet, cancelTx);
    loan.settled = true;
    saveLoansRegistry(registry);
    return res;
  } else {
    // EscrowFinish: Defaulted loan, claims collateral to LENDING_POOL
    const finishTx: EscrowFinish = {
      TransactionType: "EscrowFinish",
      Account: lendingPoolWallet.address,
      Owner: loan.borrowerAddress,
      OfferSequence: loan.escrowSequence,
      Condition: loan.condition,
      Fulfillment: loan.fulfillment,
    };

    const res = await submitTx(lendingPoolWallet, finishTx);
    loan.settled = true;
    saveLoansRegistry(registry);
    return res;
  }
}

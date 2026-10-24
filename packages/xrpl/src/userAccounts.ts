// Moonshift user accounts: a fresh devnet account per connected wallet, held by
// the api for the user (custodial, like a brokerage account). Created ready to
// use: faucet XRP for reserves, trust lines for USDC (TDX), GPU shares and
// GPU-hour contracts, and a starting balance from the issuers.
//
// Never logs or returns anything but the seed to the caller, which stores it
// encrypted.

import type { SubmittableTransaction, TrustSet, Payment, Wallet } from "xrpl";
import { explorerUrl, type TxResult } from "@moonshift/shared";
import { getClient, withAccountLock } from "./client.js";
import { getAccountWallet } from "./wallets.js";

export const STARTING_BALANCE = { usdc: "10000", gpa: "500", gpb: "200" };
const TRUST_LIMIT = "1000000000";

// Several transactions from one account in one ledger: sequential Sequence
// numbers, submitted together, then waited on together. Saves a ledger close
// (about 4 s on devnet) per transaction compared to submitAndWait one by one.
async function submitMany(wallet: Wallet, txs: SubmittableTransaction[]): Promise<TxResult[]> {
  const client = await getClient();
  return withAccountLock(wallet.address, async () => {
    const info = await client.request({ command: "account_info", account: wallet.address, ledger_index: "current" });
    const seq = info.result.account_data.Sequence;
    const hashes: string[] = [];
    for (let i = 0; i < txs.length; i++) {
      const prepared = await client.autofill({ ...txs[i], Account: wallet.address, Sequence: seq + i } as SubmittableTransaction);
      const signed = wallet.sign(prepared);
      const res = await client.submit(signed.tx_blob);
      const prelim = res.result.engine_result;
      if (!/^(tesSUCCESS|terQUEUED)$/.test(prelim)) throw new Error(`${txs[i].TransactionType} rejected: ${prelim}`);
      hashes.push(signed.hash);
    }
    const out: TxResult[] = [];
    for (const hash of hashes) {
      for (let i = 0; ; i++) {
        try {
          const r = await client.request({ command: "tx", transaction: hash });
          if (r.result.validated) {
            const result = String((r.result.meta as any)?.TransactionResult ?? "unknown");
            if (result !== "tesSUCCESS") throw new Error(`transaction ${hash} failed: ${result}`);
            out.push({ hash, result, validated: true, explorerUrl: explorerUrl(hash) });
            break;
          }
        } catch (e: any) {
          if (e?.data?.error !== "txnNotFound") throw e;
        }
        if (i > 60) throw new Error(`transaction ${hash} not validated in time`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return out;
  });
}

export interface CreatedUserAccount {
  seed: string;
  address: string;
  txs: { label: string; hash: string }[];
  ms: { fund: number; trust: number; balance: number; total: number };
}

export async function createUserAccount(start = STARTING_BALANCE): Promise<CreatedUserAccount> {
  const client = await getClient();
  const t0 = Date.now();
  const { wallet } = await client.fundWallet();
  if (!wallet.seed) throw new Error("faucet returned no seed");
  const t1 = Date.now();

  const tdx = getAccountWallet("TDX_ISSUER");
  const shares = getAccountWallet("SHARE_ISSUER");
  const contracts = getAccountWallet("CONTRACT_ISSUER");
  const line = (currency: string, issuer: string): TrustSet => ({
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: { currency, issuer, value: TRUST_LIMIT },
  });
  const trust = await submitMany(wallet, [
    line("TDX", tdx.address),
    line("GPA", shares.address),
    line("GPB", shares.address),
    line("HRA", contracts.address),
    line("HRB", contracts.address),
  ]);
  const t2 = Date.now();

  const pay = (issuer: Wallet, currency: string, value: string): Payment => ({
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: wallet.address,
    Amount: { currency, issuer: issuer.address, value },
  });
  const [usdc, gpu] = await Promise.all([
    submitMany(tdx, [pay(tdx, "TDX", start.usdc)]),
    submitMany(shares, [pay(shares, "GPA", start.gpa), pay(shares, "GPB", start.gpb)]),
  ]);
  const t3 = Date.now();

  return {
    seed: wallet.seed,
    address: wallet.address,
    txs: [
      ...trust.map((t, i) => ({ label: `trust line ${["TDX", "GPA", "GPB", "HRA", "HRB"][i]}`, hash: t.hash })),
      { label: `${start.usdc} USDC`, hash: usdc[0].hash },
      { label: `${start.gpa} GPU-A shares`, hash: gpu[0].hash },
      { label: `${start.gpb} GPU-B shares`, hash: gpu[1].hash },
    ],
    ms: { fund: t1 - t0, trust: t2 - t1, balance: t3 - t2, total: t3 - t0 },
  };
}

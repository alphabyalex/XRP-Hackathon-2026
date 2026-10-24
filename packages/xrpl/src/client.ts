import { Client, type SubmittableTransaction, type TxResponse, type Wallet } from "xrpl";
import { explorerUrl, networkInfo } from "@moonshift/shared";
import type { TxResult } from "@moonshift/shared";
import { LedgerRejected } from "./errors.js";

let clientInstance: Client | null = null;
let connectingPromise: Promise<Client> | null = null;

export async function getClient(): Promise<Client> {
  if (clientInstance && clientInstance.isConnected()) {
    return clientInstance;
  }
  if (connectingPromise) {
    return connectingPromise;
  }

  // NETWORK picks devnet or testnet; see packages/shared/src/network.ts.
  const endpoint = networkInfo().wss;
  connectingPromise = (async () => {
    const client = new Client(endpoint);
    await client.connect();
    clientInstance = client;
    connectingPromise = null;
    return client;
  })();

  return connectingPromise;
}

export async function disconnectClient(): Promise<void> {
  if (clientInstance && clientInstance.isConnected()) {
    await clientInstance.disconnect();
  }
  clientInstance = null;
  connectingPromise = null;
}

// In-process submission queue per account to prevent sequence collisions
const accountLocks = new Map<string, Promise<unknown>>();

export async function withAccountLock<T>(account: string, action: () => Promise<T>): Promise<T> {
  const current = accountLocks.get(account) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  accountLocks.set(account, current.then(() => next, () => next));
  await current;
  try {
    return await action();
  } finally {
    release!();
  }
}

export async function submitTx(
  wallet: Wallet,
  tx: SubmittableTransaction,
  options?: { autofill?: boolean }
): Promise<TxResult> {
  return (await submitTxFull(wallet, tx, options)).txResult;
}

// Same as submitTx but also returns the raw response, for callers that need
// metadata (created ledger entry IDs, final fields).
export async function submitTxFull(
  wallet: Wallet,
  tx: SubmittableTransaction,
  options?: { autofill?: boolean; signedBlob?: string }
): Promise<{ txResult: TxResult & { sequence?: number }; response: TxResponse }> {
  const client = await getClient();
  return withAccountLock(wallet.address, async () => {
    let blob = options?.signedBlob;
    if (!blob) {
      const txToSubmit = { ...tx };
      if (!txToSubmit.Account) {
        txToSubmit.Account = wallet.address;
      }
      const prepared = options?.autofill === false ? txToSubmit : await client.autofill(txToSubmit);
      blob = wallet.sign(prepared).tx_blob;
    }
    const res = await client.submitAndWait(blob);

    const meta = res.result.meta;
    const result = typeof meta === "object" && meta !== null && "TransactionResult" in meta
      ? String(meta.TransactionResult)
      : (res.result as any).engine_result ?? "unknown";

    const hash = res.result.hash;
    const validated = Boolean(res.result.validated ?? (res.result as any).ledger_index);
    const url = explorerUrl(hash);
    const sequence = (res.result as any).tx_json?.Sequence ?? (res.result as any).Sequence;

    const txResult: TxResult & { sequence?: number } = {
      hash,
      result,
      validated,
      explorerUrl: url,
      sequence,
    };

    if (result.startsWith("tec")) {
      // Transaction was included on-ledger and claimed fee, but failed
      return { txResult, response: res };
    }

    if (result !== "tesSUCCESS") {
      throw new LedgerRejected(result, `Transaction did not succeed: ${result}`, hash);
    }

    return { txResult, response: res };
  });
}

// Ledger index of the entry of this type the transaction created, if any.
export function createdEntryId(res: TxResponse, type: string): string | undefined {
  const meta = res.result.meta as any;
  return meta?.AffectedNodes?.find((n: any) => n.CreatedNode?.LedgerEntryType === type)?.CreatedNode?.LedgerIndex;
}

export function createdEntryFields(res: TxResponse, type: string): Record<string, any> | undefined {
  const meta = res.result.meta as any;
  return meta?.AffectedNodes?.find((n: any) => n.CreatedNode?.LedgerEntryType === type)?.CreatedNode?.NewFields;
}

// Validated ledger entry by index, or null when it does not exist.
export async function getLedgerEntry<T = any>(index: string): Promise<T | null> {
  const client = await getClient();
  try {
    const res = await client.request({ command: "ledger_entry", index, ledger_index: "validated" } as any);
    return (res.result as any).node as T;
  } catch (e: any) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

// Validated ledger close time in Ripple epoch seconds.
export async function ledgerCloseTime(): Promise<number> {
  const client = await getClient();
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}

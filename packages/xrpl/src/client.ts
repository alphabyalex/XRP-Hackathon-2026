import { Client, type SubmittableTransaction, type Wallet } from "xrpl";
import { explorerUrl, XRPL_WSS } from "@moonshift/shared";
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

  const endpoint = process.env.QUICKNODE_WSS || process.env.XRPL_WSS || XRPL_WSS;
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
  const client = await getClient();
  return withAccountLock(wallet.address, async () => {
    const txToSubmit = { ...tx };
    if (!txToSubmit.Account) {
      txToSubmit.Account = wallet.address;
    }

    const prepared = options?.autofill === false ? txToSubmit : await client.autofill(txToSubmit);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

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
      return txResult;
    }

    if (result !== "tesSUCCESS") {
      throw new LedgerRejected(result, `Transaction did not succeed: ${result}`, hash);
    }

    return txResult;
  });
}

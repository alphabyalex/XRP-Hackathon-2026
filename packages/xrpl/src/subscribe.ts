import { getClient } from "./client.js";

export async function subscribe(
  accounts: string[],
  onTx: (tx: unknown) => void
): Promise<() => void> {
  const client = await getClient();

  const handler = (event: any) => {
    if (event && event.type === "transaction" && event.validated) {
      const tx = event.transaction ?? event.tx_json ?? event;
      onTx(tx);
    }
  };

  client.on("transaction", handler);

  if (accounts.length > 0) {
    try {
      await client.request({
        command: "subscribe",
        accounts,
      });
    } catch (e) {
      console.warn("XRPL subscribe error:", (e as Error).message);
    }
  }

  return async () => {
    client.off("transaction", handler);
    if (accounts.length > 0 && client.isConnected()) {
      try {
        await client.request({
          command: "unsubscribe",
          accounts,
        });
      } catch {
        // ignore on cleanup
      }
    }
  };
}

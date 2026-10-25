import { networkName } from "@moonshift/shared";

/** Receiving rental revenue needs an existing ledger account, not its private key.
 * Outgoing treasury actions are available only when that account can sign. */
export function canSignGpuTreasury(gpuId: string): boolean {
  if (!/^gpu-[a-h]$/.test(gpuId)) return false;
  if (process.env.MOCK_XRPL !== "0") return true;
  const prefix = networkName() === "devnet" ? "DEVNET_" : "";
  return Boolean(process.env[`${prefix}TREASURY_GPU_${gpuId.slice(-1).toUpperCase()}_SEED`]?.trim());
}

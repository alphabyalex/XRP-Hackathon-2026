import { GPUS, type GpuId } from "@moonshift/shared";
import type { AccountName, Balances, Holder } from "@moonshift/shared";
import { getClient } from "./client.js";
import { getAccountAddress } from "./wallets.js";

export async function getBalances(account: AccountName): Promise<Balances> {
  const client = await getClient();
  const address = getAccountAddress(account);

  let xrp = "0.000000";
  try {
    const bal = await client.getXrpBalance(address);
    xrp = Number(bal).toFixed(6);
  } catch {
    xrp = "0.000000";
  }

  const tokens: Record<string, string> = {};
  try {
    const linesRes = await client.request({
      command: "account_lines",
      account: address,
      ledger_index: "validated",
    });

    for (const line of linesRes.result.lines) {
      const val = Number(line.balance);
      if (val !== 0) {
        tokens[line.currency] = line.balance;
      }
    }
  } catch {
    // No lines or account not found
  }

  return { xrp, tokens };
}

export async function getHolders(gpuId: GpuId): Promise<Holder[]> {
  const client = await getClient();
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) {
    throw new Error(`Unknown gpuId: ${gpuId}`);
  }

  const shareIssuerAddress = getAccountAddress("SHARE_ISSUER");
  const treasuryAAddress = getAccountAddress("TREASURY_GPU_A");
  const treasuryBAddress = getAccountAddress("TREASURY_GPU_B");

  const excluded = new Set([
    shareIssuerAddress,
    treasuryAAddress,
    treasuryBAddress,
  ]);

  const holders: Holder[] = [];

  try {
    const linesRes = await client.request({
      command: "account_lines",
      account: shareIssuerAddress,
      ledger_index: "validated",
    });

    for (const line of linesRes.result.lines) {
      if (line.currency !== gpu.shareCode) continue;
      if (excluded.has(line.account)) continue;

      const sharesNumber = Math.abs(Number(line.balance));
      if (sharesNumber > 0) {
        holders.push({
          account: line.account,
          shares: String(sharesNumber),
        });
      }
    }
  } catch {
    // If linesRes fails or no holders
  }

  return holders;
}

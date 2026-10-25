import type { Request, Response, NextFunction } from "express";
import type { AccountName } from "@moonshift/shared";
import { actorFor } from "./session.js";
import { getClient, getAccountAddress } from "@moonshift/xrpl";

export class FundingError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

// Fail closed. A browser claim, remembered balance, or simulated ledger is
// never sufficient to admit a paid GPU prompt.
export async function readFunding(account: AccountName) {
  if (process.env.MOCK_XRPL !== "0") throw new FundingError("BALANCE_UNAVAILABLE", "The live USDC balance is unavailable.", 503);
  try {
    const client = await getClient();
    const address = getAccountAddress(account), issuer = getAccountAddress("TDX_ISSUER");
    let marker: unknown;
    let balance = "0";
    for (let page = 0; page < 20; page++) {
      const response: any = await client.request({ command: "account_lines", account: address, ledger_index: "validated", ...(marker ? { marker } : {}) } as any);
      if (response.result.validated === false) throw new Error("Ledger is not validated");
      const line = response.result.lines?.find((line: any) => line.currency === "TDX" && line.account === issuer);
      if (line) { balance = String(line.balance); break; }
      marker = response.result.marker;
      if (!marker) break;
      if (page === 19) throw new Error("Balance pagination incomplete");
    }
    if (!Number.isFinite(Number(balance))) throw new Error("Invalid balance");
    return { balance, balanceUpdatedAt: new Date().toISOString() };
  } catch {
    throw new FundingError("BALANCE_UNAVAILABLE", "Your USDC balance could not be checked. Please try again.", 503);
  }
}

export function assertFunded(balance: string) {
  if (!Number.isFinite(Number(balance)) || Number(balance) <= 0) throw new FundingError("USDC_REQUIRED", "Add USDC to your account before running a model.", 402);
}

export function promptFunding(reader = readFunding) {
return async function requirePromptFunding(req: Request, res: Response, next: NextFunction) {
  try {
    const account = actorFor(req, req.body?.buyer);
    const funding = await reader(account);
    assertFunded(funding.balance);
    req.body = { ...req.body, buyer: account };
    next();
  } catch (error) {
    const e = error as { status?: number; code?: string; message: string };
    res.status(e.status ?? 503).json({ error: { code: e.code ?? "BALANCE_UNAVAILABLE", message: e.message } });
  }
}

}
export const requirePromptFunding = promptFunding();

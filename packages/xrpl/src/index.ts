// Stubbed implementation of the packages/xrpl contract (A9.1).
// Owner: Tharun. Replace each function body, keep the exact signature so
// apps/api (which imports this directly) never needs to change its calls.
// Every write function must return TxResult = { hash, result, validated, explorerUrl }.

import type {
  AccountName,
  AccountsFile,
  Balances,
  Holder,
  Offer,
  TxResult,
  BuySharesParams,
  SellSharesParams,
  BuyContractsParams,
  RedeemContractsParams,
  RedeemContractsResult,
  PayForInferenceParams,
  PayDividendsParams,
  OpenLoanParams,
  OpenLoanResult,
  PublishOracleParams,
} from "@moonshift/shared";
import type { GpuId } from "@moonshift/shared";

function notImplemented(name: string): never {
  throw new Error(
    `NotImplemented: ${name}. This is a packages/xrpl stub, implement the real XRPL calls here (owner: Tharun).`
  );
}

export async function setupNetwork(): Promise<AccountsFile> {
  return notImplemented("setupNetwork");
}

export async function getBalances(account: AccountName): Promise<Balances> {
  return notImplemented(`getBalances(${account})`);
}

export async function getHolders(gpuId: GpuId): Promise<Holder[]> {
  return notImplemented(`getHolders(${gpuId})`);
}

export async function listShareOffers(gpuId: GpuId): Promise<Offer[]> {
  return notImplemented(`listShareOffers(${gpuId})`);
}

export async function buyShares(p: BuySharesParams): Promise<TxResult> {
  return notImplemented(`buyShares(${JSON.stringify(p)})`);
}

export async function sellShares(p: SellSharesParams): Promise<TxResult> {
  return notImplemented(`sellShares(${JSON.stringify(p)})`);
}

export async function listContractOffers(gpuId: GpuId): Promise<Offer[]> {
  return notImplemented(`listContractOffers(${gpuId})`);
}

export async function buyContracts(p: BuyContractsParams): Promise<TxResult> {
  return notImplemented(`buyContracts(${JSON.stringify(p)})`);
}

export async function redeemContracts(
  p: RedeemContractsParams
): Promise<RedeemContractsResult> {
  return notImplemented(`redeemContracts(${JSON.stringify(p)})`);
}

export async function payForInference(p: PayForInferenceParams): Promise<TxResult> {
  return notImplemented(`payForInference(${JSON.stringify(p)})`);
}

export async function payDividends(p: PayDividendsParams): Promise<TxResult[]> {
  return notImplemented(`payDividends(${JSON.stringify(p)})`);
}

export async function openLoan(p: OpenLoanParams): Promise<OpenLoanResult> {
  return notImplemented(`openLoan(${JSON.stringify(p)})`);
}

export async function repayLoan(p: { loanId: string }): Promise<TxResult> {
  return notImplemented(`repayLoan(${JSON.stringify(p)})`);
}

export async function settleLoan(p: { loanId: string }): Promise<TxResult> {
  return notImplemented(`settleLoan(${JSON.stringify(p)})`);
}

export async function publishOracle(p: PublishOracleParams): Promise<TxResult> {
  return notImplemented(`publishOracle(${JSON.stringify(p)})`);
}

export async function subscribe(
  accounts: string[],
  onTx: (tx: unknown) => void
): Promise<() => void> {
  void accounts;
  void onTx;
  return notImplemented("subscribe");
}

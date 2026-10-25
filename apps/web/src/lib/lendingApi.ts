// apps/api lending routes (XLS-65 vault, XLS-66 loans). See docs/CONTRACTS.md.
import { useEffect, useRef } from "react";
import type {
  AgentText,
  BookStats,
  CreditProfile,
  CreditStats,
  LoanQuoteApiResponse,
  StressResult,
  TxResult,
  VaultOverview,
  XlsLoanRecord,
} from "@moonshift/shared";
import { apiFetch, eventsUrl } from "./api";

const post = <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const getVault = () => apiFetch<VaultOverview>("/vault");
// Personal calls act for the signed-in account; the api resolves "me" from the session.
export const getPositions = () =>
  apiFetch<{ account: string; positions: { round: number; phase: string; shares: string; value: string }[] }>("/vault/positions/me");
export const deposit = (amount: string) => post<{ round: number; tx: TxResult }>("/vault/deposit", { amount });
export const withdraw = (amount: string) => post<{ round: number; tx: TxResult }>("/vault/withdraw", { amount });

// principal "max" quotes the largest amount risk approves.
export const quoteLoan = (gpuId: string, collateralShares: string, principal: string, init?: RequestInit) =>
  apiFetch<LoanQuoteApiResponse>("/loans/quote", { ...init, method: "POST", body: JSON.stringify({ gpuId, collateralShares, principal }) });
export const creditStats = () => apiFetch<CreditStats>("/credit/stats");
// The borrower's cached credit profile, so the score can show before the quote.
export const borrowerProfile = (init?: RequestInit) => apiFetch<CreditProfile & { dataSource: string }>("/loans/profile/me", init);
export const maxPrincipal = (gpuId: string, collateralShares: string, init?: RequestInit) =>
  apiFetch<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("/loans/max", {
    ...init,
    method: "POST",
    body: JSON.stringify({ gpuId, collateralShares }),
  });
// Long-polls the quote's Bedrock memo (the api holds the request up to waitMs).
export const quoteMemo = (quoteId: string, waitMs = 12_000) =>
  apiFetch<{ status: "ready" | "pending"; memo: AgentText | null }>(`/loans/quote/${quoteId}/memo?wait=${waitMs}`);
// The signed-in wallet (Crossmark testnet sign-in) and its Moonshift account.
export type ConnectedWallet = { network: string; address: string; verified: boolean; status: string; connectedAt: string };
export type WalletSession = { wallet: ConnectedWallet | null; account: { address: string; created?: boolean; setupMs?: number } | null };
export const walletGet = (init?: RequestInit) => apiFetch<WalletSession & { activity?: unknown[] }>("/wallet/me", init);
export const walletChallenge = () => post<{ challengeId: string; message: string; messageHex: string; expiresAt: string }>("/wallet/challenge", {});
export const walletVerify = (b: { challengeId: string; publicKey: string; signature: string; address?: string }) => post<WalletSession>("/wallet/verify", b);
export const walletDisconnect = () => apiFetch<{ wallet: null }>("/wallet/me", { method: "DELETE" });
export const openFromQuote = (quoteId: string) => post<XlsLoanRecord>("/loans/open", { quoteId });
// mine: the signed-in account's loans; otherwise the public loan book.
export const listLoans = (mine = false) => apiFetch<{ loans: XlsLoanRecord[] }>(`/loans${mine ? "?borrower=me" : ""}`);
export const payNext = (id: string) => post<XlsLoanRecord>(`/loans/${id}/pay`, { mode: "next" });
export const payOff = (id: string) => post<XlsLoanRecord>(`/loans/${id}/repay`, { mode: "full" });

export const stress = (gpuId: string, level: "margin_call" | "liquidation", loanId?: string) =>
  post<StressResult>("/demo/stress", { gpuId, level, loanId });
export const restorePrice = (gpuId: string) => post<{ price: string; tx: TxResult }>("/demo/stress/restore", { gpuId });
export const bookStats = (grade?: string) =>
  apiFetch<BookStats & { dataSource: string }>(`/risk/book-stats${grade ? `?grade=${grade}` : ""}`);

// Explorer link for a hash on the loan's network; mock hashes have none.
export function txUrl(network: string, hash?: string | null): string | null {
  if (!hash || hash.startsWith("MOCK") || network === "mock") return null;
  const base = network === "mainnet" ? "https://livenet.xrpl.org" : network === "testnet" ? "https://testnet.xrpl.org" : "https://devnet.xrpl.org";
  return `${base}/transactions/${hash}`;
}

export const pct = (fraction: string | number, d = 1) => `${(Number(fraction) * 100).toFixed(d)}%`;

// Calls `onEvent` for the given SSE event types from apps/api /events.
export function useApiEvents(types: string[], onEvent: (type: string, data: any) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = types.join(",");
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(eventsUrl());
      for (const t of key.split(",")) {
        es.addEventListener(t, (e) => {
          let data: any = null;
          try {
            data = JSON.parse((e as MessageEvent).data);
          } catch {
            // ignore malformed payloads
          }
          cb.current(t, data);
        });
      }
    } catch {
      // api unreachable; pages also poll
    }
    return () => es?.close();
  }, [key]);
}

// apps/api lending routes (XLS-65 vault, XLS-66 loans). See docs/CONTRACTS.md.
import { useEffect, useRef } from "react";
import type {
  BookStats,
  CreditStats,
  LoanQuoteApiResponse,
  StressResult,
  TxResult,
  VaultOverview,
  XlsLoanRecord,
} from "@moonshift/shared";
import { apiFetch, eventsUrl } from "./api";

export const LENDER = "BOB"; // demo lender persona

const post = <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const getVault = () => apiFetch<VaultOverview>("/vault");
export const getPositions = (account: string) =>
  apiFetch<{ account: string; positions: { round: number; phase: string; shares: string; value: string }[] }>(`/vault/positions/${account}`);
export const deposit = (lender: string, amount: string) => post<{ round: number; tx: TxResult }>("/vault/deposit", { lender, amount });
export const withdraw = (lender: string, amount: string) => post<{ round: number; tx: TxResult }>("/vault/withdraw", { lender, amount });

export const quoteLoan = (borrower: string, gpuId: string, collateralShares: string, principal: string) =>
  post<LoanQuoteApiResponse>("/loans/quote", { borrower, gpuId, collateralShares, principal });
export const creditStats = () => apiFetch<CreditStats>("/credit/stats");
export const maxPrincipal = (borrower: string, gpuId: string, collateralShares: string) =>
  post<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("/loans/max", { borrower, gpuId, collateralShares });
export const openFromQuote = (quoteId: string) => post<XlsLoanRecord>("/loans/open", { quoteId });
export const listLoans = (borrower?: string) =>
  apiFetch<{ loans: XlsLoanRecord[] }>(`/loans${borrower ? `?borrower=${encodeURIComponent(borrower)}` : ""}`);
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
  const base = network === "testnet" ? "https://testnet.xrpl.org" : "https://devnet.xrpl.org";
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

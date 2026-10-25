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
import { API_BASE, ApiUnreachableError, apiFetch, eventsUrl, getPortfolio } from "./api";

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
// An api error that keeps its code (OVER_LIMIT, LENDING_UNAVAILABLE, ...).
export class ApiCodeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiCodeError";
  }
}

async function postCoded<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw new ApiUnreachableError();
  }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiCodeError(res.status, b?.error?.code ?? "INTERNAL", b?.error?.message ?? `apps/api returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// 409 OVER_LIMIT when the quote is above what risk approves: never a smaller loan.
export const openFromQuote = (quoteId: string) => postCoded<XlsLoanRecord>("/loans/open", { quoteId });

// Every GPU the signed-in account holds shares in. GET /loans/collateral-options,
// or the account's own share balances while that route is not deployed.
export type CollateralOption = { gpuId: string; label: string; shares: number };
export async function collateralOptions(): Promise<CollateralOption[]> {
  const norm = (rows: any[]) =>
    rows
      .map((r) => ({
        gpuId: String(r.gpuId ?? r.id),
        label: String(r.label ?? String(r.gpuId ?? r.id).toUpperCase()),
        shares: Number(r.shares ?? r.qty ?? r.held ?? r.available ?? 0),
      }))
      .filter((o) => o.gpuId && o.shares > 0);
  try {
    const r = await apiFetch<any>("/loans/collateral-options");
    const rows = Array.isArray(r) ? r : (r?.options ?? r?.gpus ?? []);
    if (Array.isArray(rows)) return norm(rows);
  } catch {
    // not deployed yet: fall through to the portfolio
  }
  const p = await getPortfolio();
  return norm(p.shares);
}
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

// ---------------------------------------------------------------------------
// Lend page: markets, dashboard, loan book (GET /lending/*). Until those routes
// are deployed, each returns null and the page reads /vault and /loans instead.
// ---------------------------------------------------------------------------

// A route that is not deployed yet answers 404 once; it is asked again a minute later.
const missing = new Map<string, number>();
async function optional<T>(path: string): Promise<T | null> {
  const since = missing.get(path);
  if (since && Date.now() - since < 60_000) return null;
  try {
    const r = await apiFetch<T>(path);
    missing.delete(path);
    return r;
  } catch {
    missing.set(path, Date.now());
    return null;
  }
}

export const lendingMarkets = () => optional<any>("/lending/markets");
export const lendingDashboard = () => optional<any>("/lending/dashboard");
export const lendingLoanbook = () => optional<any>("/lending/loanbook");
export const lendingBaseApr = () => optional<any>("/lending/base-apr");

// POST /applications: "capital" (borrowers) or "market" (GPU operators who want a vault funded).
export type ApplicationKind = "capital" | "market";
export const submitApplication = (body: { kind: ApplicationKind; name: string; email: string; company?: string; details: string; [k: string]: unknown }) =>
  postCoded<{ id: string; status: string; createdAt: string }>("/applications", body);

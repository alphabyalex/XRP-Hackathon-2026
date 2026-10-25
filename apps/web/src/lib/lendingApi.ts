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
import { API_BASE, ApiUnreachableError, NotFoundError, apiFetch, eventsUrl, getPortfolio } from "./api";
import { LendingReadCache, lendingInputKey } from "./lendingCache";

const reads = new LendingReadCache();
let sessionScope: string | null = null;
let sessionEpoch = 0;
let sourceVersion = "initial";
const sourceParts = new Map<string, string>();
export function invalidateLendingReads() { reads.clear(); }
function scopeFor(session: WalletSession) {
  const next = session.wallet && session.account ? `${session.wallet.address}:${session.account.address}` : null;
  if (next !== sessionScope) { sessionScope = next; reads.clear(); }
}
function privateRead<T>(path: string, load: () => Promise<T>, input: Record<string, unknown> = {}, version = sourceVersion, ttl = 2000) {
  if (typeof window === "undefined" || !sessionScope) return load();
  return reads.read(lendingInputKey(sessionScope, path, input, version), ttl, load);
}
function recordSource(path: string, value: unknown) { sourceParts.set(path, JSON.stringify(value)); sourceVersion = JSON.stringify([...sourceParts]); }
async function mutation<T>(load: () => Promise<T>) { reads.clear(); try { return await load(); } finally { reads.clear(); } }
const post = <T,>(path: string, body: unknown) => mutation(() => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }));

export const getVault = async () => {
  const result = await apiFetch<VaultOverview>("/vault");
  recordSource("vault", [result.investing?.round, result.investing?.assetsAvailable, result.investing?.redemptionDate]);
  return result;
};
// Personal calls act for the signed-in account; the api resolves "me" from the session.
export const getPositions = () =>
  privateRead("/vault/positions/me", () => apiFetch<{ account: string; positions: { round: number; phase: string; shares: string; value: string }[] }>("/vault/positions/me"));
export const deposit = (amount: string) => post<{ round: number; tx: TxResult }>("/vault/deposit", { amount });
export const withdraw = (amount: string) => post<{ round: number; tx: TxResult }>("/vault/withdraw", { amount });

// principal "max" quotes the largest amount risk approves.
// 409 OVER_LIMIT (with the api's own message) when principal is above what these shares can borrow.
export const quoteLoan = (gpuId: string, collateralShares: string, principal: string, options: { termSeconds?: number; sourceVersion?: string } = {}) =>
  privateRead("/loans/quote", () => postCoded<LoanQuoteApiResponse>("/loans/quote", { gpuId, collateralShares, principal, ...(options.termSeconds ? { termSeconds: options.termSeconds } : {}) }),
    { gpuId, collateralShares, principal, termSeconds: options.termSeconds ?? null }, options.sourceVersion ?? sourceVersion);
export const creditStats = () => apiFetch<CreditStats>("/credit/stats");
// The borrower's cached credit profile, so the score can show before the quote.
export const borrowerProfile = (init?: RequestInit) => init?.signal ? apiFetch<CreditProfile & { dataSource: string }>("/loans/profile/me", init)
  : privateRead("/loans/profile/me", () => apiFetch<CreditProfile & { dataSource: string }>("/loans/profile/me", init));
export const maxPrincipal = (gpuId: string, collateralShares: string, init?: RequestInit) => {
  const load = () => apiFetch<{ maxPrincipal: string; collateralValue: string; termSeconds: number }>("/loans/max", {
    ...init,
    method: "POST",
    body: JSON.stringify({ gpuId, collateralShares }),
  });
  return init?.signal ? load() : privateRead("/loans/max", load, { gpuId, collateralShares });
};
// Long-polls the quote's Bedrock memo (the api holds the request up to waitMs).
export const quoteMemo = (quoteId: string, waitMs = 12_000) =>
  privateRead(`/loans/quote/${quoteId}/memo`, () => apiFetch<{ status: "ready" | "pending"; memo: AgentText | null }>(`/loans/quote/${quoteId}/memo?wait=${waitMs}`), { quoteId, waitMs }, sourceVersion, 500);
// The signed-in wallet (Crossmark testnet sign-in) and its Moonshift account.
export type ConnectedWallet = { network: string; address: string; verified: boolean; status: string; connectedAt: string };
export type WalletSession = { wallet: ConnectedWallet | null; account: { address: string; created?: boolean; setupMs?: number } | null };
export const walletGet = async (init?: RequestInit) => {
  const epoch = sessionEpoch;
  const result = await apiFetch<WalletSession & { activity?: unknown[] }>("/wallet/me", init);
  if (epoch !== sessionEpoch) throw new Error("Wallet session changed during this read.");
  if (typeof window !== "undefined") scopeFor(result);
  return result;
};
export const walletChallenge = () => post<{ challengeId: string; message: string; messageHex: string; expiresAt: string }>("/wallet/challenge", {});
export const walletVerify = async (b: { challengeId: string; publicKey: string; signature: string; address?: string }) => { sessionEpoch++; scopeFor({ wallet: null, account: null }); const result = await post<WalletSession>("/wallet/verify", b); scopeFor(result); return result; };
export const walletDisconnect = () => { sessionEpoch++; scopeFor({ wallet: null, account: null }); return mutation(() => apiFetch<{ wallet: null }>("/wallet/me", { method: "DELETE" })); };
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
export const openFromQuote = (quoteId: string) => mutation(() => postCoded<XlsLoanRecord>("/loans/open", { quoteId }));

// Every GPU the signed-in account holds shares in. GET /loans/collateral-options,
// or the account's own share balances while that route is not deployed.
export type CollateralOption = { gpuId: string; label: string; shares: number; price?: number; maxBorrow?: number };
export function collateralOptions(): Promise<CollateralOption[]> { return privateRead("/loans/collateral-options", readCollateralOptions); }
async function readCollateralOptions(): Promise<CollateralOption[]> {
  const norm = (rows: any[]) =>
    rows
      .map((r) => ({
        gpuId: String(r.gpuId ?? r.id),
        label: String(r.label ?? String(r.gpuId ?? r.id).toUpperCase()),
        shares: Number(r.shares ?? r.qty ?? r.held ?? r.available ?? 0),
        ...(Number(r.price) > 0 ? { price: Number(r.price) } : {}),
        ...(Number.isFinite(Number(r.maxBorrow)) ? { maxBorrow: Number(r.maxBorrow) } : {}),
      }))
      .filter((o) => o.gpuId && o.shares > 0);
  if (LENDING_ROUTES_LIVE) {
    try {
      const r = await apiFetch<any>("/loans/collateral-options");
      const rows = Array.isArray(r) ? r : (r?.options ?? r?.gpus ?? []);
      if (Array.isArray(rows)) return norm(rows);
    } catch {
      // fall through to the portfolio
    }
  }
  const p = await getPortfolio();
  return norm(p.shares);
}
// mine: the signed-in account's loans; otherwise the public loan book.
export const listLoans = (mine = false) => mine ? privateRead("/loans?borrower=me", () => apiFetch<{ loans: XlsLoanRecord[] }>("/loans?borrower=me"))
  : apiFetch<{ loans: XlsLoanRecord[] }>("/loans");
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
  // Some routes send the explorer link itself.
  if (/^https:\/\/[a-z]+\.xrpl\.org\/transactions\/[0-9A-F]{64}$/i.test(hash)) return hash;
  if (!/^[0-9A-F]{64}$/i.test(hash)) return null;
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
          invalidateLendingReads();
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

// The lending routes (collateral-options, /lending/*, /applications) answer on the api.
// Set to false only if they go away: the pages then read /vault, /loans and /portfolio/me.
export const LENDING_ROUTES_LIVE = true;

// A route that is not deployed yet answers 404 once; it is asked again a minute later.
const missing = new Map<string, number>();
async function optional<T>(path: string): Promise<T | null> {
  if (!LENDING_ROUTES_LIVE) return null;
  const since = missing.get(path);
  if (since && Date.now() - since < 60_000) return null;
  try {
    const load = () => apiFetch<T>(path);
    const r = path === "/lending/dashboard" ? await privateRead(path, load) : await load();
    missing.delete(path);
    return r;
  } catch (error) {
    if (error instanceof NotFoundError) missing.set(path, Date.now());
    return null;
  }
}

export const lendingMarkets = () => optional<any>("/lending/markets");
export const lendingDashboard = () => optional<any>("/lending/dashboard");
export const lendingLoanbook = () => optional<any>("/lending/loanbook");
export const lendingBaseApr = async () => { const result = await optional<any>("/lending/base-apr"); if (result) recordSource("base-apr", [result.baseAprPct, result.source]); return result; };

// POST /applications: "capital" (borrowers) or "market" (GPU operators who want a vault funded).
export type ApplicationKind = "capital" | "market";
export const submitApplication = (body: { kind: ApplicationKind; name: string; email: string; company?: string; details: string; [k: string]: unknown }) =>
  mutation(() => postCoded<{ id: string; status: string; createdAt: string }>("/applications", body));

"use client";
// /lend: two subtabs. Lending markets (the rounds lenders fund, deposit into
// the open one, how risk is priced) and the Lending dashboard (book totals,
// live charts, the loan book). Everything refreshes every 5 s and on the api's
// vault, loan and risk events.
import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultOverview, XlsLoanRecord } from "@moonshift/shared";
import { usdc } from "@/lib/format";
import { deposit, getPositions, getVault, lendingDashboard, lendingLoanbook, lendingMarkets, listLoans, useApiEvents, withdraw } from "@/lib/lendingApi";
import { useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";
import { Segmented } from "./Segmented";
import type { LinePoint } from "./charts";
import { Markets, marketsFromApi, marketsFromVault } from "./lending/Markets";
import { Dashboard, rowFromLoan, type BookRow, type Totals } from "./lending/Dashboard";
import "./lending/lending.css";

type Tab = "markets" | "dashboard";
const TABS: { value: Tab; label: string }[] = [
  { value: "markets", label: "Lending markets" },
  { value: "dashboard", label: "Lending dashboard" },
];
const MAX_POINTS = 720;

const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const asPct = (v: unknown) => {
  const x = n(v);
  return x === null ? null : x > 0 && x <= 1 ? x * 100 : x;
};

function seriesFrom(raw: any, key: string, percent = false): LinePoint[] | null {
  const s = raw?.series;
  if (!Array.isArray(s) || s.length === 0) return null;
  return s
    .map((p: any) => ({ t: new Date(p.at ?? p.t).getTime(), v: percent ? asPct(p[key]) : n(p[key]) }))
    .filter((p: any): p is LinePoint => Number.isFinite(p.t) && p.v !== null);
}

function rowFromApi(r: any): BookRow {
  return {
    id: String(r.id ?? r.loanId),
    borrower: String(r.borrowerAddress ?? r.borrower ?? ""),
    gpuId: String(r.gpuId ?? ""),
    principal: Number(r.principal ?? 0),
    outstanding: n(r.outstanding),
    apr: (asPct(r.apr) ?? 0) / 100,
    ltv: n(r.ltv),
    marginCallLtv: n(r.marginCallLtv),
    liquidationLtv: n(r.liquidationLtv),
    state: String(r.state ?? r.status ?? ""),
    network: String(r.network ?? "devnet"),
    tx: r.txs?.loanSet ?? r.tx ?? null,
    openedAt: r.openedAt ?? null,
  };
}

export function LendContent() {
  const [tab, setTab] = useState<Tab>("markets");
  const [vault, setVault] = useState<VaultOverview | null>(null);
  const [loans, setLoans] = useState<XlsLoanRecord[] | null>(null);
  const [marketsRaw, setMarketsRaw] = useState<any>(null);
  const [dashRaw, setDashRaw] = useState<any>(null);
  const [bookRaw, setBookRaw] = useState<any>(null);
  const [positions, setPositions] = useState<{ round: number; phase: string; shares: string; value: string }[]>([]);
  const [liveOut, setLiveOut] = useState<LinePoint[]>([]);
  const [liveUtil, setLiveUtil] = useState<LinePoint[]>([]);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const { wallet } = useWallet();
  const signedIn = !!wallet;
  const inflight = useRef(false);

  useEffect(() => {
    if (window.location.hash === "#dashboard") setTab("dashboard");
  }, []);
  function pickTab(t: Tab) {
    setTab(t);
    try {
      history.replaceState(null, "", t === "dashboard" ? "#dashboard" : window.location.pathname);
    } catch {
      // ignore
    }
  }

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      await Promise.all([
        getVault()
          .then((v) => {
            setVault(v);
            setErr(null);
            const r = v.investing;
            if (r) {
              const t = Date.now();
              setLiveOut((p) => [...p, { t, v: Number(r.debtTotal) }].slice(-MAX_POINTS));
              setLiveUtil((p) => [...p, { t, v: Number(r.utilizationPct) }].slice(-MAX_POINTS));
            }
          })
          .catch((e) => setErr((e as Error).message)),
        listLoans()
          .then((l) => setLoans(l.loans))
          .catch(() => {}),
        lendingMarkets().then(setMarketsRaw),
        lendingDashboard().then(setDashRaw),
        lendingLoanbook().then(setBookRaw),
        signedIn
          ? getPositions()
              .then((p) => setPositions(p.positions))
              .catch(() => {})
          : Promise.resolve(setPositions([])),
      ]);
    } finally {
      inflight.current = false;
    }
  }, [signedIn]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useApiEvents(["vault", "loan", "risk"], () => void refresh());

  async function move(kind: "deposit" | "withdraw") {
    setBusy(kind);
    try {
      const r = kind === "deposit" ? await deposit(amount) : await withdraw(amount);
      toast(kind === "deposit" ? `Deposited ${usdc(amount)} USDC` : `Withdrew ${usdc(amount)} USDC`, `Round ${r.round}`, r.tx.hash);
      setAmount("");
      await refresh();
    } catch (e) {
      toast(kind === "deposit" ? "Deposit failed" : "Withdraw failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const markets = marketsFromApi(marketsRaw) ?? (vault ? marketsFromVault(vault) : null);

  const rowsApi = Array.isArray(bookRaw?.loans) ? (bookRaw.loans as any[]).map(rowFromApi) : null;
  const rows: BookRow[] | null = rowsApi ?? (loans ? loans.map(rowFromLoan) : null);
  const openRows = (rows ?? []).filter((r) => r.state === "open" || r.state === "margin_call");
  const weighted = (() => {
    const p = openRows.reduce((s, r) => s + r.principal, 0);
    return p > 0 ? (openRows.reduce((s, r) => s + r.principal * r.apr, 0) / p) * 100 : null;
  })();
  const inv = vault?.investing;
  const totals: Totals = {
    outstanding: n(dashRaw?.outstanding) ?? n(inv?.debtTotal),
    available: n(dashRaw?.available) ?? n(inv?.assetsAvailable),
    utilization: asPct(dashRaw?.utilization) ?? n(inv?.utilizationPct),
    weightedApr: asPct(dashRaw?.weightedApr) ?? weighted,
    defaults: n(dashRaw?.defaults) ?? (rows ? rows.filter((r) => r.state === "liquidated" || r.state === "defaulted").length : null),
    marginCalls: n(dashRaw?.marginCalls) ?? (loans ? loans.filter((l) => l.marginCallAt).length : null),
    cover: n(dashRaw?.cover) ?? n(inv?.coverAvailable),
  };

  return (
    <main className="s lend-page">
      <div className="wrap">
        <div className="shead lend-head">
          <h2>Lend USDC against GPU cash flow.</h2>
          <p>
            Lenders fund rounds. Each round lends to holders of GPU shares, secured by the shares and a first-loss cover. Every deposit, loan and
            repayment is on the ledger.
          </p>
        </div>
        <div className="lend-tabs">
          <Segmented options={TABS} value={tab} onChange={pickTab} />
        </div>
        {err && <p className="note dn">{err}</p>}
        {tab === "markets" ? (
          <Markets markets={markets} signedIn={signedIn} amount={amount} setAmount={setAmount} busy={busy} onMove={move} positions={positions} />
        ) : (
          <Dashboard
            totals={totals}
            outstandingSeries={seriesFrom(dashRaw, "outstanding") ?? liveOut}
            utilizationSeries={seriesFrom(dashRaw, "utilization", true) ?? liveUtil}
            rows={rows}
          />
        )}
      </div>
    </main>
  );
}

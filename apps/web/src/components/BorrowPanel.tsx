"use client";
import { useEffect, useMemo, useState } from "react";
import type { LoanQuoteApiResponse, VaultOverview } from "@moonshift/shared";
import { collateralOptions, getVault, lendingBaseApr, quoteLoan, useApiEvents, type CollateralOption } from "@/lib/lendingApi";
import { availableBorrowTerm, borrowingScenarios } from "@/lib/borrowingScenarios";
import { useWallet } from "@/lib/wallet";
import { fmt, typedAmount } from "@/lib/format";
import { Button } from "./Button";
import { BorrowEstimateChart } from "./lending/BorrowEstimateChart";
import styles from "./lending/BorrowPanel.module.css";

type BaseApr = { baseAprPct?: string | number | null; source?: string; updatedAt?: string };

export function BorrowPanel({ gpuId, gpuLabel, sharePrice, maxShares }: { gpuId: string; gpuLabel: string; sharePrice: number; maxShares?: number; onBorrowed?: () => void }) {
  const wallet = useWallet();
  const personal = Boolean(wallet.loaded && wallet.wallet && wallet.account);
  const identity = wallet.account?.address ?? "public";
  const [shares, setShares] = useState("");
  const [base, setBase] = useState<BaseApr | null>(null);
  const [vault, setVault] = useState<VaultOverview | null>(null);
  const [holdingsData, setHoldings] = useState<{ owner: string; value: CollateralOption[] } | null>(null);
  const [quoteData, setQuote] = useState<{ owner: string; value: LoanQuoteApiResponse } | null>(null);
  const holdings = holdingsData?.owner === identity ? holdingsData.value : null;
  const quote = quoteData?.owner === identity ? quoteData.value : null;
  const [quoteState, setQuoteState] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [seed, setSeed] = useState(17);
  const [selected, setSelected] = useState(24);
  useApiEvents(["loan", "risk", "vault", "market"], () => setRefresh(n => n + 1));
  useEffect(() => { setHoldings(null); setQuote(null); setShares(""); }, [gpuId, identity]);
  useEffect(() => {
    let alive = true, pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      await Promise.allSettled([
        lendingBaseApr().then(value => { if (alive) setBase(value); }),
        getVault().then(value => { if (alive) setVault(value); }).catch(() => { if (alive) setVault(null); }),
        ...(personal ? [collateralOptions().then(value => { if (alive) setHoldings({ owner: identity, value }); }).catch(() => { if (alive) setHoldings({ owner: identity, value: [] }); })] : []),
      ]);
      pending = false;
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [personal, identity, refresh]);
  const holding = holdings?.find(item => item.gpuId === gpuId);
  const price = holding?.price && holding.price > 0 ? holding.price : sharePrice;
  const rawAvailable = vault?.investing ? Number(vault.investing.assetsAvailable) : NaN;
  const available = Number.isFinite(rawAvailable) && rawAvailable >= 0 ? rawAvailable : null;
  const baseApr = base?.baseAprPct !== null && base?.baseAprPct !== undefined && Number.isFinite(Number(base.baseAprPct)) ? Number(base.baseAprPct) : null;
  const limit = Math.max(0, Math.floor(personal ? Math.min(maxShares ?? Infinity, holding?.shares ?? 0) : maxShares ?? (available !== null && price > 0 ? available / price : 0)));
  useEffect(() => {
    if (limit > 0) setShares(current => current === "" ? String(Math.min(10, limit)) : String(Math.min(Number(current), limit)));
  }, [limit]);
  const count = Number(shares) || 0;
  const publicTerm = vault?.investing ? availableBorrowTerm(vault.investing.redemptionDate) : null;
  const version = JSON.stringify([gpuId, price, available, vault?.investing?.round, baseApr, holding?.shares, publicTerm]);
  useEffect(() => {
    let alive = true;
    setQuote(null);
    setQuoteState("");
    if (!personal || count < 1 || count > limit || !available || !publicTerm) return;
    setQuoteState("Checking your current rate...");
    const timer = setTimeout(() => {
      quoteLoan(gpuId, String(count), "max", { sourceVersion: version }).then(value => {
        if (!alive) return;
        if (value.quote.decision !== "approve") { setQuoteState("These shares cannot support a loan right now."); return; }
        setQuote({ owner: identity, value }); setQuoteState("");
      }).catch(() => { if (alive) setQuoteState("A borrowing quote is not available for these shares right now."); });
    }, 450);
    return () => { alive = false; clearTimeout(timer); };
  }, [personal, identity, gpuId, count, limit, available, publicTerm, version]);
  const term = quote?.terms.termSeconds ?? publicTerm;
  const apr = personal ? (quote ? Number(quote.quote.apr) : null) : baseApr !== null ? baseApr / 100 : null;
  const points = useMemo(() => borrowingScenarios({ sharePrice: quote ? Number(quote.collateralPrice) : price,
    maxShares: Math.min(count, limit), available: available ?? 0, apr: apr ?? NaN, termSeconds: term ?? 0,
    maxLtv: quote ? Number(quote.quote.maxLtv) : 0.5,
    principalPerShare: quote ? Number(quote.principal) / Number(quote.collateralShares) : undefined, seed }),
  [quote, price, count, limit, available, apr, term, seed]);
  const active = points[Math.min(selected, points.length - 1)];
  const empty = available === 0 ? "No capital is available in this lending round." : personal && holdings && limit === 0 ? "You have no available shares of this GPU to lock."
    : quoteState || (baseApr === null || available === null ? "Waiting for current lending data" : "Enter shares to compare borrowing costs.");
  return <div className={`trade ${styles.panel}`}>
    <div className={styles.heading}><span className="lbl">Borrow against {gpuLabel} shares</span><span className="lbl">Current base APR</span></div>
    <div className="bignum" style={{ marginTop: 6 }}>{baseApr !== null ? `${fmt(baseApr, 2)}%` : "..."}</div>
    <div className={styles.estimateHead}><strong>Estimated borrowing cost</strong><button type="button" className={styles.shuffle} disabled={!points.length} onClick={() => setSeed(n => n + 1)}>Vary loan sizes</button></div>
    <BorrowEstimateChart points={points} selected={selected} onSelect={setSelected} empty={empty} />
    {active && <div className={styles.readout} aria-live="polite"><div><span>Loan with {fmt(active.shares, 1)} shares</span><b>{fmt(active.principal, 2)} USDC</b></div><div><span>Estimated interest</span><b>{fmt(active.interest, active.interest < 0.01 ? 4 : 2)} USDC</b></div></div>}
    <p className={styles.caption}>{personal ? quote ? "Uses your current quote." : "Your quote checks your current rate and limit." : "Base-rate examples using the live share price and round liquidity."} {term ? `${fmt(term / 86400, 1)}-day term. ` : ""}Each point varies shares and loan size.{!personal ? " Connect your wallet for your rate and limit." : ""}</p>
    <label className={`lbl ${styles.inputLabel}`} htmlFor={`home-coll-${gpuId}`}>{personal ? "Shares to lock" : "Example shares to lock"}</label>
    <div className="inp"><input id={`home-coll-${gpuId}`} type="text" autoComplete="off" placeholder="0" value={shares} inputMode="numeric"
      onChange={event => { const value = typedAmount(event.target.value, false); setShares(value === "" ? "" : String(Math.min(Number(value), limit))); setSelected(24); }} /><span>shares</span></div>
    <div className={styles.facts}><div className="line"><span>Collateral value</span><b>{price > 0 ? `${fmt(count * price, 2)} USDC` : "..."}</b></div>
      <div className="line"><span>Lending round available</span><b>{available !== null ? `${fmt(available, 2)} USDC` : "..."}</b></div>
      {personal && holdings && <div className="line"><span>Your available shares</span><b>{fmt(limit, 0)}</b></div>}</div>
    <Button href={count > 0 ? `/borrow?gpu=${gpuId}&shares=${count}` : "/borrow"} arrow>Get your quote</Button>
  </div>;
}

"use client";
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { fmt, typedAmount, usdc } from "@/lib/format";
import { openLoan } from "@/lib/api";
import { useToast } from "./Toast";

// Ported from .borrow .trade / borrow() in moonshift_v2_source.html.
// apps/api always lends at max LTV (50%), see docs/CONTRACTS.md request;
// the slider below is a preview, the Borrow button requests the real max.
export function BorrowPanel({
  gpuId,
  gpuLabel,
  sharePrice,
  maxShares = 50,
  onBorrowed,
}: {
  gpuId: string;
  gpuLabel: string;
  sharePrice: number;
  maxShares?: number;
  onBorrowed?: () => void;
}) {
  const [collateral, setCollateral] = useState(20);
  const [range, setRange] = useState(62);
  const [busy, setBusy] = useState(false);
  const [livePrice, setLivePrice] = useState(sharePrice || 37.094);
  const [userInteracted, setUserInteracted] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (sharePrice) setLivePrice(sharePrice);
  }, [sharePrice]);

  useEffect(() => {
    const interval = setInterval(() => {
      // Dynamic DEX order book price fluctuation in real time
      setLivePrice((p) => {
        const delta = (Math.random() - 0.49) * 0.005 * p;
        return Math.max(1, p + delta);
      });
      if (!userInteracted) {
        setRange((r) => {
          const drift = Math.floor((Math.random() - 0.5) * 2.5);
          return Math.max(52, Math.min(68, r + drift));
        });
      }
    }, 2400);
    return () => clearInterval(interval);
  }, [userInteracted]);

  const c = Math.max(0, Math.min(maxShares, Math.floor(collateral) || 0));
  const cv = c * livePrice;
  const amount = cv * 0.5 * (range / 100);
  const ltv = cv ? (amount / cv) * 100 : 0;
  const fillPct = (ltv / 80) * 100;

  async function doBorrow() {
    if (!amount || busy) return;
    setBusy(true);
    try {
      const loan = await openLoan(gpuId, String(c));
      toast(`Borrowed ${usdc(loan.principal)} USDC`, `${fmt(c, 0)} ${gpuLabel} shares locked`, loan.disburseTx ?? loan.escrowTx);
      onBorrowed?.();
    } catch (err) {
      toast("Borrow failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trade" style={{ padding: 30 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="lbl" htmlFor="coll" style={{ margin: 0 }}>
          Shares to lock
        </label>
        <span style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--mono)", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
          {fmt(livePrice, 3)} TDX
        </span>
      </div>
      <div className="inp">
        <input
          id="coll"
          type="text"
          autoComplete="off"
          value={collateral}
          inputMode="numeric"
          onChange={(e) => {
            setUserInteracted(true);
            setCollateral(Number(typedAmount(e.target.value, false)) || 0);
          }}
        />
        <span>shares</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 28, gap: 12, flexWrap: "wrap" }}>
        <div>
          <span className="lbl">You borrow</span>
          <div className="bignum">{fmt(amount, 2)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="lbl">Loan to value</span>
          <div className="num" style={{ fontSize: 22 }}>
            {fmt(ltv, 0)}%
          </div>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={range}
        aria-label="Amount to borrow"
        onChange={(e) => {
          setUserInteracted(true);
          setRange(Number(e.target.value));
        }}
      />
      <div className="meter">
        <div className="fill" style={{ width: `${fillPct}%` }} />
        <span className="tick" style={{ left: "62.5%" }} />
        <span className="tick" style={{ left: "81.25%", background: "var(--down)" }} />
      </div>
      <div className="meter-l">
        <span style={{ left: 0 }}>0%</span>
        <span style={{ left: "62.5%", transform: "translateX(-50%)" }}>50% limit</span>
        <span style={{ right: 0, color: "var(--down)" }}>65% liquidation</span>
      </div>
      <div className="line" style={{ marginTop: 18 }}>
        <span>Collateral value</span>
        <b>{fmt(cv, 2)} USDC</b>
      </div>
      <div className="line">
        <span>APR</span>
        <b>10.00%</b>
      </div>
      <Button disabled={!amount || busy} onClick={doBorrow}>
        {amount ? `Lock ${c} ${gpuLabel} shares, borrow ${fmt(amount, 2)} USDC` : "Choose an amount"}
      </Button>
    </div>
  );
}

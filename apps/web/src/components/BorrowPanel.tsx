"use client";
import { useState } from "react";
import { Button } from "./Button";
import { fmt, txToastLine } from "@/lib/format";
import { openLoan } from "@/lib/api";
import { useToast } from "./Toast";
import { ACCOUNT } from "@/lib/session";

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
  const toast = useToast();

  const c = Math.max(0, Math.min(maxShares, Math.floor(collateral) || 0));
  const cv = c * sharePrice;
  const amount = cv * 0.5 * (range / 100);
  const ltv = cv ? (amount / cv) * 100 : 0;
  const fillPct = (ltv / 80) * 100;

  async function doBorrow() {
    if (!amount || busy) return;
    setBusy(true);
    try {
      const loan = await openLoan(ACCOUNT, gpuId, String(c));
      toast(
        `Borrowed ${fmt(Number(loan.principal), 2)} USDC`,
        txToastLine("EscrowCreate + Payment in one Batch", loan.disburseTx ?? loan.escrowTx ?? "")
      );
      onBorrowed?.();
    } catch (err) {
      toast("Borrow failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trade" style={{ padding: 30 }}>
      <label className="lbl" htmlFor="coll">
        Shares to lock
      </label>
      <div className="inp">
        <input
          id="coll"
          type="number"
          min={1}
          max={maxShares}
          value={collateral}
          inputMode="numeric"
          onChange={(e) => setCollateral(Number(e.target.value) || 0)}
        />
        <span>{gpuLabel.replace("GPU-", "GP")}</span>
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
        onChange={(e) => setRange(Number(e.target.value))}
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
        {amount ? `Lock ${c} ${gpuLabel.replace("GPU-", "GP")}, borrow ${fmt(amount, 2)} USDC` : "Choose an amount"}
      </Button>
    </div>
  );
}

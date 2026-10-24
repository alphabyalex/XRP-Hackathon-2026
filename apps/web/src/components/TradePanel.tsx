"use client";
import { useState } from "react";
import { Segmented } from "./Segmented";
import { ComputeCheckout } from "./ComputeCheckout";
import { Button } from "./Button";
import { fmt, txToastLine, typedAmount } from "@/lib/format";
import { perSharePerNight } from "@/lib/economics";
import { buyShares } from "@/lib/api";
import { useRefreshLive } from "@/lib/liveData";
import { useToast } from "./Toast";

// Ported from .trade / #seg / trade() in moonshift_v2_source.html.
export function TradePanel({
  gpuId,
  gpuLabel,
  sharePrice,
  revenue24h,
  onTraded,
}: {
  gpuId: string;
  gpuLabel: string;
  sharePrice: number;
  revenue24h: number;
  nowIndex: number;
  slots: ("b" | "l" | "i" | "o")[];
  windowStart: Date;
  onTraded?: () => void;
}) {
  const [tab, setTab] = useState<"time" | "shares">("time");
  const [qty, setQty] = useState(10);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const refreshLive = useRefreshLive();

  async function doBuyShares() {
    if (!qty || busy) return;
    setBusy(true);
    try {
      const tx = await buyShares(gpuId, String(qty));
      toast(`Bought ${qty} ${gpuLabel} shares`, txToastLine(`${fmt(qty * sharePrice, 2)} USDC · OfferCreate`, tx.hash));
      refreshLive();
      onTraded?.();
    } catch (err) {
      toast("Purchase failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nightly = perSharePerNight(revenue24h) * qty;

  return (
    <div className="trade">
      <Segmented
        options={[
          { value: "time", label: "Rent compute" },
          { value: "shares", label: "Buy shares" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "time" ? (
        <ComputeCheckout />
      ) : (
        <div>
          <label className="lbl" htmlFor="qty">
            Shares of {gpuLabel}
          </label>
          <div className="inp">
            <input
              id="qty"
              type="text"
              autoComplete="off"
              value={qty}
              inputMode="numeric"
              onChange={(e) => setQty(Number(typedAmount(e.target.value, false)) || 0)}
            />
            <span>shares</span>
          </div>
          <div className="line" style={{ marginTop: 14 }}>
            <span>Price</span>
            <b>{fmt(sharePrice, 3)} USDC</b>
          </div>
          <div className="line">
            <span>Paid to you nightly</span>
            <b>{fmt(nightly, 6)} USDC</b>
          </div>
          <div className="line tot">
            <span>Total</span>
            <b>{fmt(qty * sharePrice, 2)} USDC</b>
          </div>
          <Button disabled={!qty || busy} onClick={doBuyShares}>
            {qty ? `Buy ${qty} ${gpuLabel} shares` : "Enter an amount"}
          </Button>
          <p className="note">Fills against the {gpuLabel} shares / USDC order book on the XRP Ledger DEX.</p>
        </div>
      )}
    </div>
  );
}

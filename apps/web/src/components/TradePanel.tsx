"use client";
import { useState } from "react";
import { Segmented } from "./Segmented";
import { SlotPicker, type PickableSlot } from "./SlotPicker";
import { Button } from "./Button";
import { fmt, txToastLine, typedAmount } from "@/lib/format";
import { hm, timeAt } from "@/lib/schedule";
import { perSharePerNight, mockSlotPrice } from "@/lib/economics";
import { buyShares, bookSlots, redeemSlots } from "@/lib/api";
import { useRefreshLive } from "@/lib/liveData";
import { useToast } from "./Toast";
import { ACCOUNT } from "@/lib/session";

// Ported from .trade / #seg / trade() in moonshift_v2_source.html.
export function TradePanel({
  gpuId,
  gpuLabel,
  sharePrice,
  revenue24h,
  nowIndex,
  slots,
  windowStart,
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
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [qty, setQty] = useState(10);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const refreshLive = useRefreshLive();

  const pricePerSlot = mockSlotPrice(revenue24h);
  const pickable: PickableSlot[] = [];
  for (let i = nowIndex + 1; i <= Math.min(slots.length - 1, nowIndex + 24); i++) {
    pickable.push({ index: i, label: hm(timeAt(windowStart, i)), booked: slots[i] === "b" });
  }

  function toggle(i: number) {
    setSel((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  async function doBookTime() {
    if (!sel.size || busy) return;
    setBusy(true);
    try {
      // Buy the slot tokens, then redeem each run of back-to-back slots so the
      // GPU's calendar actually shows the time as booked.
      const tx = await bookSlots(ACCOUNT, gpuId, String(sel.size));
      const picked = Array.from(sel).sort((a, b) => a - b);
      const runs: { start: number; len: number }[] = [];
      for (const i of picked) {
        const last = runs[runs.length - 1];
        if (last && last.start + last.len === i) last.len++;
        else runs.push({ start: i, len: 1 });
      }
      for (const r of runs) {
        await redeemSlots(ACCOUNT, gpuId, String(r.len), timeAt(windowStart, r.start).toISOString());
      }
      toast(`Booked ${sel.size * 5} minutes on ${gpuLabel}`, txToastLine(`${sel.size} HRA · ${fmt(pricePerSlot * sel.size, 4)} USDC`, tx.hash));
      setSel(new Set());
      refreshLive();
      onTraded?.();
    } catch (err) {
      toast("Booking failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doBuyShares() {
    if (!qty || busy) return;
    setBusy(true);
    try {
      const tx = await buyShares(ACCOUNT, gpuId, String(qty));
      toast(`Bought ${qty} ${gpuLabel.replace("GPU-", "GP")}`, txToastLine(`${fmt(qty * sharePrice, 2)} USDC · OfferCreate`, tx.hash));
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
          { value: "time", label: "Book time" },
          { value: "shares", label: "Buy shares" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "time" ? (
        <div>
          <span className="lbl">{gpuLabel}, next two hours</span>
          <SlotPicker slots={pickable} selected={sel} onToggle={toggle} />
          <div className="line">
            <span>Price per slot</span>
            <b>{fmt(pricePerSlot, 4)} USDC</b>
          </div>
          <div className="line tot">
            <span>
              {sel.size} slot{sel.size === 1 ? "" : "s"}
            </span>
            <b>{fmt(pricePerSlot * sel.size, 4)} USDC</b>
          </div>
          <Button disabled={!sel.size || busy} onClick={doBookTime}>
            {sel.size ? `Book ${sel.size * 5} minutes` : "Pick a slot"}
          </Button>
          <p className="note">Each slot is an HRA token. Hold it for exclusive access, or resell it on the DEX.</p>
        </div>
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
            <span>{gpuLabel.replace("GPU-", "GP")}</span>
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
            {qty ? `Buy ${qty} ${gpuLabel.replace("GPU-", "GP")}` : "Enter an amount"}
          </Button>
          <p className="note">Fills against the {gpuLabel.replace("GPU-", "GP")}/USDC order book on the XRP Ledger DEX.</p>
        </div>
      )}
    </div>
  );
}

"use client";
// The next 7 days of one GPU, an hour per cell, from GET /gpus/:id/calendar (real bookings and
// admitted work only). Pick a free hour to book it with POST /bookings; the hour is paid on the
// ledger before it counts as booked.
import { useMemo, useState } from "react";
import clsx from "clsx";
import { bookHour } from "@/lib/api";
import { useGpuCalendar, type CalendarBlock } from "@/lib/catalog";
import { fmt } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { ConnectPrompt } from "./ConnectPrompt";

const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
const hourLabel = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric" });

function cellState(b: CalendarBlock, now: number): "past" | "busy" | "booked" | "free" {
  if (new Date(b.end).getTime() <= now) return "past";
  if (b.runningMinutes > 0) return "busy";
  if (b.bookedMinutes > 0 || b.status !== "free") return "booked";
  return "free";
}

export function BookingCalendar({ gpuId, gpuLabel, pricePerHour }: { gpuId: string; gpuLabel: string; pricePerHour: number | null }) {
  const { data, error } = useGpuCalendar(gpuId);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { wallet } = useWallet();
  const toast = useToast();
  const now = Date.now();

  // Group the hourly blocks into local days.
  const days = useMemo(() => {
    const out = new Map<string, CalendarBlock[]>();
    for (const b of data?.blocks ?? []) {
      const d = new Date(b.start);
      const k = d.toDateString();
      const day = out.get(k) ?? [];
      // One cell per clock hour: on the night clocks fall back, the repeated hour shows once.
      if (!day.some((x) => new Date(x.start).getHours() === d.getHours())) out.set(k, [...day, b]);
    }
    return [...out.entries()];
  }, [data]);

  async function book() {
    if (!pick || busy || pricePerHour === null) return;
    setBusy(true);
    try {
      // The cap is the live hourly rate plus 10% so a small move while signing doesn't fail it.
      const r = await bookHour(gpuId, pick, (pricePerHour * 1.1).toFixed(6));
      toast(`Booked ${gpuLabel}`, `${dayLabel(new Date(r.slotStart))}, ${hourLabel(new Date(r.slotStart))} for ${fmt(Number(r.amount), 4)} USDC`, r.payment?.hash);
      setPick(null);
    } catch (err) {
      toast("Booking failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <p className="note">{error ? "The calendar is not available right now." : "Loading the calendar"}</p>;
  }
  const picked = data.blocks.find((b) => b.start === pick);

  return (
    <div className="cal7">
      <div className="cal7-grid" role="grid" aria-label={`${gpuLabel}, next 7 days`}>
        <div className="cal7-row cal7-hours" aria-hidden="true">
          <span />
          <div className="cal7-cells">
            {["12 AM", "6 AM", "12 PM", "6 PM"].map((h, i) => (
              <span key={h} style={{ gridColumn: `${i * 6 + 1} / span 6` }}>
                {h}
              </span>
            ))}
          </div>
        </div>
        {days.map(([k, blocks]) => (
          <div className="cal7-row" role="row" key={k}>
            <span className="cal7-day">{dayLabel(new Date(blocks[0].start))}</span>
            <div className="cal7-cells">
              {blocks.map((b) => {
                const st = cellState(b, now);
                const d = new Date(b.start);
                return (
                  <button
                    key={b.start}
                    type="button"
                    role="gridcell"
                    disabled={st !== "free"}
                    aria-selected={pick === b.start}
                    title={`${dayLabel(d)} ${hourLabel(d)}: ${st === "free" ? "free" : st === "past" ? "past" : st === "busy" ? "running a task" : "booked"}`}
                    className={clsx("cal7-cell", st, pick === b.start && "on")}
                    style={{ gridColumnStart: d.getHours() + 1 }}
                    onClick={() => setPick(b.start)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="key">
        <span>
          <i className="cal7-cell free" />
          Free
        </span>
        <span>
          <i className="cal7-cell booked" />
          Booked
        </span>
        <span>
          <i className="cal7-cell busy" />
          Running
        </span>
      </div>
      <div className="line tot" style={{ marginTop: 16 }}>
        <span>{picked ? `${dayLabel(new Date(picked.start))}, ${hourLabel(new Date(picked.start))}` : "Pick a free hour"}</span>
        <b>{pricePerHour === null ? "Price not available" : `${fmt(pricePerHour, 4)} USDC`}</b>
      </div>
      {wallet ? (
        <Button disabled={!picked || busy || pricePerHour === null} onClick={book}>
          {busy ? "Booking..." : picked ? "Book this hour" : "Pick an hour to book"}
        </Button>
      ) : (
        <ConnectPrompt />
      )}
    </div>
  );
}

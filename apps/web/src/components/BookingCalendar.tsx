"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { bookRange, quoteBookingRange, requestBookingConsent } from "@/lib/api";
import { useGpuCalendar, type CalendarBlock } from "@/lib/catalog";
import { contiguousHours, freeHour } from "@/lib/bookingRange";
import { signBooking, type BookingQuote, type SignedBooking } from "@/lib/bookingWallet";
import { fmt } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { ConnectPrompt } from "./ConnectPrompt";
import "./BookingCalendar.css";

const dayLabel = (date: Date) => date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" });
const hourLabel = (date: Date) => date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
function cellState(block: CalendarBlock, now: number) {
  if (Date.parse(block.end) <= now) return "past";
  if (block.runningMinutes > 0) return "busy";
  if (block.bookedMinutes > 0 || block.status !== "free") return "booked";
  return freeHour(block, now) ? "free" : "past";
}

export function BookingCalendar({ gpuId, gpuLabel, pricePerHour }: { gpuId: string; gpuLabel: string; pricePerHour: number | null }) {
  const { data, error } = useGpuCalendar(gpuId);
  const [pick, setPick] = useState<string[]>([]);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteError, setQuoteError] = useState(false);
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState<"idle" | "preparing" | "signing" | "booking">("idle");
  const [proof, setProof] = useState<SignedBooking | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const { wallet, account, refresh } = useWallet();
  const toast = useToast();
  const anchor = useRef<string | null>(null);
  const dragging = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const proofKey = useRef("");
  const blocks = data?.blocks ?? [];
  const selected = blocks.filter(block => pick.includes(block.start));
  const start = selected[0]?.start;
  const end = selected.at(-1)?.end;
  const durationSeconds = start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : 0;
  const rangeKey = start ? `${gpuId}:${start}:${durationSeconds}` : "";
  const busy = phase !== "idle";
  const now = Date.now();
  const firstFree = blocks.find(block => freeHour(block, now))?.start;
  const days = useMemo(() => {
    const grouped = new Map<string, CalendarBlock[]>();
    for (const block of data?.blocks ?? []) {
      const key = block.start.slice(0, 10);
      grouped.set(key, [...(grouped.get(key) ?? []), block]);
    }
    return [...grouped.entries()];
  }, [data]);

  useEffect(() => { setProof(null); proofKey.current = ""; }, [wallet?.address, gpuId]);
  useEffect(() => {
    setQuote(null);
    setQuoteError(false);
    if (!start || !durationSeconds) return;
    let alive = true;
    const load = () => quoteBookingRange({ gpuId, slotStart: start, durationSeconds }).then(value => {
      if (alive) { setQuote(value); setQuoteError(false); }
    }).catch(() => { if (alive) { setQuote(null); setQuoteError(true); } });
    const delay = setTimeout(load, 150);
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearTimeout(delay); clearInterval(timer); };
  }, [gpuId, rangeKey, start, durationSeconds]);

  function choose(from: string, to: string) {
    if (busy) return;
    const range = contiguousHours(blocks, from, to, Date.now());
    if (!range.length) { setNotice("Choose up to 24 consecutive free hours."); return; }
    setNotice("");
    setPick(range.map(block => block.start));
    setProof(null);
    proofKey.current = "";
  }
  function moveKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const jumps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -24, ArrowDown: 24 };
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const from = event.shiftKey ? anchor.current ?? blocks[index].start : blocks[index].start;
      anchor.current = from; choose(from, blocks[index].start); return;
    }
    if (!(event.key in jumps)) return;
    event.preventDefault();
    let next = Math.min(blocks.length - 1, Math.max(0, index + jumps[event.key]));
    while (!event.shiftKey && !freeHour(blocks[next], now) && next > 0 && next < blocks.length - 1) next += Math.sign(jumps[event.key]);
    if (!freeHour(blocks[next], now)) return;
    const from = event.shiftKey ? anchor.current ?? blocks[index].start : blocks[next].start;
    anchor.current = from;
    choose(from, blocks[next].start);
    setFocus(blocks[next].start);
    grid.current?.querySelector<HTMLButtonElement>(`[data-booking-index="${next}"]`)?.focus();
  }
  function inputRange(value: string, edge: "start" | "end") {
    const time = Date.parse(`${value}:00Z`);
    if (!Number.isFinite(time)) return;
    const first = edge === "start" ? blocks.find(block => Date.parse(block.start) === time) : selected[0];
    const last = edge === "end" ? blocks.find(block => Date.parse(block.end) === time) : selected.at(-1);
    if (!first || !last) { setNotice("Choose a range inside the available calendar."); return; }
    if (Date.parse(last.end) <= Date.parse(first.start)) { setNotice("End time must follow start time."); return; }
    anchor.current = first.start; choose(first.start, last.start);
  }
  async function book() {
    if (!wallet || !start || !durationSeconds || busy) return;
    const key = `${wallet.address}:${rangeKey}`;
    try {
      let signed = proofKey.current === key ? proof : null;
      if (!signed) {
        if (!quote) return;
        setPhase("preparing");
        const challenge = await requestBookingConsent({ gpuId, slotStart: start, durationSeconds, priceCap: quote.priceCap });
        setPhase("signing");
        signed = await signBooking(challenge, wallet.address, { gpuId, slotStart: start, durationSeconds, priceCap: quote.priceCap, account: account?.address });
        proofKey.current = key;
        setProof(signed);
      }
      setPhase("booking");
      const result = await bookRange(signed);
      toast(`Booked ${gpuLabel}`, `${dayLabel(new Date(result.slotStart))}, ${hourLabel(new Date(result.slotStart))} to ${dayLabel(new Date(result.slotEnd))}, ${hourLabel(new Date(result.slotEnd))} UTC for ${fmt(Number(result.amount), 4)} USDC`, result.payment?.hash);
      setPick([]); setProof(null); proofKey.current = "";
      void refresh();
    } catch (failure) {
      // Retain a signed request after submission: checking it reuses the same one-use approval.
      toast("Booking not confirmed", (failure as Error).message);
    } finally { setPhase("idle"); }
  }

  if (!data) return <p className="note">{error ? "The calendar is not available right now." : "Loading the calendar"}</p>;
  const valid = selected.length > 0 && selected.every(block => freeHour(block, now));
  return <div className="cal7">
    <p className="note cal7-help">Drag across free hours, or use Shift and the arrow keys. Times are UTC.</p>
    <div className="cal7-grid" role="grid" aria-label={`${gpuLabel}, next 7 days, UTC`} ref={grid}>
      <div className="cal7-row cal7-hours" aria-hidden="true"><span /><div className="cal7-cells">
        {["00:00", "06:00", "12:00", "18:00"].map((label, index) => <span key={label} style={{ gridColumn: `${index * 6 + 1} / span 6` }}>{label}</span>)}
      </div></div>
      {days.map(([day, row]) => <div className="cal7-row" role="row" key={day}>
        <span className="cal7-day">{dayLabel(new Date(row[0].start))}</span>
        <div className="cal7-cells">{row.map(block => {
          const state = cellState(block, now), index = blocks.indexOf(block), on = pick.includes(block.start);
          const label = `${dayLabel(new Date(block.start))} ${hourLabel(new Date(block.start))} UTC: ${state === "free" ? "free" : state === "busy" ? "running" : state}`;
          return <button key={block.start} type="button" role="gridcell" disabled={state !== "free" || busy}
            data-booking-start={block.start} data-booking-index={index} aria-label={label} aria-selected={on}
            tabIndex={(focus ?? pick[0] ?? firstFree) === block.start ? 0 : -1} title={label}
            className={clsx("cal7-cell", state, on && state === "free" && "on")} style={{ gridColumnStart: new Date(block.start).getUTCHours() + 1 }}
            onFocus={() => setFocus(block.start)} onKeyDown={event => moveKey(event, index)}
            onPointerDown={event => {
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
              anchor.current = block.start; dragging.current = true; choose(block.start, block.start);
            }}
            onPointerMove={event => {
              if (!dragging.current || !anchor.current) return;
              const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-booking-start]");
              if (target?.dataset.bookingStart && grid.current?.contains(target)) choose(anchor.current, target.dataset.bookingStart);
            }}
            onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onPointerCancel={() => { dragging.current = false; }} />;
        })}</div>
      </div>)}
    </div>
    <div className="key"><span><i className="cal7-cell free" />Free</span><span><i className="cal7-cell booked" />Booked</span><span><i className="cal7-cell busy" />Running</span></div>
    {start && end && <div className="cal7-range-fields">
      <label>Start, UTC<input type="datetime-local" step="3600" value={start.slice(0, 16)} disabled={busy} onChange={event => inputRange(event.target.value, "start")} /></label>
      <label>End, UTC<input type="datetime-local" step="3600" value={end.slice(0, 16)} disabled={busy} onChange={event => inputRange(event.target.value, "end")} /></label>
    </div>}
    <p className="note" role="status">{notice || (phase === "signing" ? "Approve the range and price cap in your wallet." : phase === "booking" ? "Confirming your reservation." : proof ? "Check this reservation before approving another payment." : !valid && selected.length ? "Some selected hours are no longer free." : "")}</p>
    <div className="line tot" style={{ marginTop: 16 }}>
      <span>{start ? `Total for ${durationSeconds / 3600} ${durationSeconds === 3600 ? "hour" : "hours"}` : "Pick consecutive free hours"}</span>
      <b>{start ? quote ? `${fmt(Number(quote.totalPrice), 6)} USDC` : quoteError ? "Price not available" : "Checking price" : pricePerHour === null ? "Price not available" : `${fmt(pricePerHour, 4)} USDC / hour`}</b>
    </div>
    {wallet ? <Button disabled={busy || (!proof && (!valid || !quote))} onClick={book}>
      {busy ? phase === "signing" ? "Waiting for wallet" : "Confirming" : proof ? "Check reservation" : "Sign and book range"}
    </Button> : <ConnectPrompt />}
  </div>;
}

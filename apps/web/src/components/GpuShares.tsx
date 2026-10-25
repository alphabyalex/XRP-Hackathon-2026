"use client";
// "Buy shares" on the GPU page: candles, book depth, the 24 hour stats, the order book and recent
// trades (each with its ledger link), and a buy / sell ticket. Refreshes on every market event and
// every 3 seconds. A number the api doesn't report yet shows a dash.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { GPUS, type ApiGpuDetail } from "@moonshift/shared";
import { Candles, DepthChart, type Tick } from "./charts";
import { Segmented } from "./Segmented";
import { Button } from "./Button";
import { LiveNumber } from "./LiveNumber";
import { useToast } from "./Toast";
import { ConnectPrompt } from "./ConnectPrompt";
import { useGpuStats, placeOrder, toMs, type BookLevel } from "@/lib/gpuMarket";
import { useRefreshLive } from "@/lib/liveData";
import { useWallet } from "@/lib/wallet";
import { fmt, typedAmount } from "@/lib/format";
import type { GpuView } from "@/lib/gpuView";

const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const levels = (ls: BookLevel[] | undefined) => (ls ?? []).map((l) => ({ price: Number(l.price), qty: Number(l.qty) })).filter((l) => l.qty > 0);

function Stat({ k, v, digits = 3, unit = "" }: { k: string; v: number | null; digits?: number; unit?: string }) {
  return (
    <div>
      <span>{k}</span>
      <b>{v === null ? "–" : <LiveNumber value={v} digits={digits} suffix={unit} />}</b>
    </div>
  );
}

export function GpuShares({ gpu, view }: { gpu: ApiGpuDetail; view: GpuView }) {
  const { data: stats } = useGpuStats(gpu.id);
  const SHARES = GPUS.find((g) => g.id === gpu.id)?.sharesTotal ?? 1000;
  const price = n(stats?.price) ?? (Number(gpu.sharePrice) || 0);

  // Price observations: the api's history, then every live price this page has seen.
  const seen = useRef<Tick[]>([]);
  const [ticks, setTicks] = useState<Tick[]>([]);
  useEffect(() => {
    if (!(price > 0)) return;
    const last = seen.current[seen.current.length - 1];
    if (!last || last.price !== price) seen.current = [...seen.current, { t: Date.now(), price }].slice(-500);
    const base: Tick[] = stats?.ticks?.length
      ? stats.ticks.map((t) => ({ t: toMs(t.t), price: Number(t.price), qty: n(t.qty) ?? undefined }))
      : (gpu.priceHistory ?? []).map((p) => ({ t: p.t < 1e12 ? p.t * 1000 : p.t, price: p.price }));
    const lastBase = base[base.length - 1]?.t ?? 0;
    setTicks([...base, ...seen.current.filter((s) => s.t > lastBase)]);
  }, [price, stats?.ticks, gpu.priceHistory]);

  const day = ticks.filter((t) => t.t >= Date.now() - 86400e3).map((t) => t.price);
  const bids = levels(stats?.bids);
  const asks = levels(stats?.asks);
  const trades = stats?.trades ?? [];

  return (
    <div className="shares-view">
      <div className="shares-main">
        <div className="panel">
          <Candles ticks={ticks} interval="1h" height={280} format={(v) => fmt(v, 3)} empty="No trades yet" label={`${view.dashLabel} share price`} />
        </div>
        <div className="facts shares-stats">
          <Stat k="24h volume" v={n(stats?.volume24h)} digits={0} unit=" shares" />
          <Stat k="24h high" v={n(stats?.high24h) ?? (day.length ? Math.max(...day) : null)} />
          <Stat k="24h low" v={n(stats?.low24h) ?? (day.length ? Math.min(...day) : null)} />
          <Stat k="Market cap" v={n(stats?.marketCap) ?? (price ? price * SHARES : null)} digits={0} unit=" USDC" />
          <Stat k="Holders" v={n(stats?.holders) ?? gpu.holdersCount} digits={0} />
          <Stat k="NAV per share" v={n(stats?.navPerShare) ?? n(gpu.navPerShare)} />
          <Stat k="Yield" v={n(stats?.yieldPct) ?? n(gpu.impliedYieldPct)} digits={1} unit="%" />
          <Stat k="Paid per share, 24h" v={n(stats?.paidPerShare24h) ?? view.split.holders / SHARES} digits={6} />
        </div>
        <div className="shares-book">
          <div className="panel">
            <h4 className="panel-h">Depth</h4>
            <DepthChart bids={bids} asks={asks} height={180} format={(v) => fmt(v, 3)} />
          </div>
          <div className="panel">
            <h4 className="panel-h">Order book</h4>
            <OrderBook bids={bids} asks={asks} />
          </div>
        </div>
        <div className="panel">
          <h4 className="panel-h">Trades</h4>
          {trades.length === 0 ? (
            <p className="note">No trades in the last 24 hours.</p>
          ) : (
            <div className="tbl">
              <table className="trades">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th className="r">Price</th>
                    <th className="r">Shares</th>
                    <th className="r">Ledger</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 12).map((t, i) => (
                    <tr key={t.hash ?? i}>
                      <td>{new Date(toMs(t.t)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</td>
                      <td className={clsx("r num", t.side === "sell" ? "dn" : t.side === "buy" ? "up" : undefined)}>{fmt(Number(t.price), 3)}</td>
                      <td className="r num">{fmt(Number(t.qty), 0)}</td>
                      <td className="r">
                        {t.explorerUrl ? (
                          <a href={t.explorerUrl} target="_blank" rel="noreferrer">
                            View
                          </a>
                        ) : (
                          "–"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <Ticket gpuId={gpu.id} gpuLabel={view.dashLabel} price={price} bestBid={bids.length ? Math.max(...bids.map((b) => b.price)) : null} />
    </div>
  );
}

function OrderBook({ bids, asks }: { bids: { price: number; qty: number }[]; asks: { price: number; qty: number }[] }) {
  const a = [...asks].sort((x, y) => x.price - y.price).slice(0, 6).reverse();
  const b = [...bids].sort((x, y) => y.price - x.price).slice(0, 6);
  if (!a.length && !b.length) return <p className="note">No orders on the book.</p>;
  const row = (l: { price: number; qty: number }, side: "up" | "dn") => (
    <div className="ob-row" key={`${side}${l.price}`}>
      <span className={side}>{fmt(l.price, 3)}</span>
      <span>{fmt(l.qty, 0)}</span>
    </div>
  );
  return (
    <div className="ob">
      <div className="ob-row ob-h">
        <span>Price</span>
        <span>Shares</span>
      </div>
      {a.map((l) => row(l, "dn"))}
      <div className="ob-mid" />
      {b.map((l) => row(l, "up"))}
    </div>
  );
}

function Ticket({ gpuId, gpuLabel, price, bestBid }: { gpuId: string; gpuLabel: string; price: number; bestBid: number | null }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const { wallet } = useWallet();
  const toast = useToast();
  const refreshLive = useRefreshLive();
  const q = Number(qty) || 0;
  // A sell fills against the best bid; a buy at the market price.
  const px = side === "sell" ? bestBid ?? price : price;

  async function submit() {
    if (!q || busy) return;
    setBusy(true);
    try {
      const tx = await placeOrder(gpuId, side, String(q), px.toFixed(6));
      toast(`${side === "buy" ? "Bought" : "Sold"} ${fmt(q, 0)} ${gpuLabel} shares`, `${fmt(q * px, 2)} USDC`, tx.hash);
      setQty("");
      refreshLive();
    } catch (err) {
      toast(side === "buy" ? "Purchase failed" : "Sale failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trade">
      <Segmented
        options={[
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
        value={side}
        onChange={setSide}
      />
      <label className="lbl" htmlFor="ticket-qty">
        Shares of {gpuLabel}
      </label>
      <div className="inp">
        <input id="ticket-qty" type="text" autoComplete="off" inputMode="numeric" placeholder="0" value={qty} onChange={(e) => setQty(typedAmount(e.target.value, false))} />
        <span>shares</span>
      </div>
      <div className="line" style={{ marginTop: 14 }}>
        <span>{side === "buy" ? "Price" : "Best bid"}</span>
        <b>{fmt(px, 3)} USDC</b>
      </div>
      <div className="line tot">
        <span>{side === "buy" ? "You pay" : "You receive"}</span>
        <b>{fmt(q * px, 2)} USDC</b>
      </div>
      {wallet ? (
        <Button disabled={!q || busy} onClick={submit}>
          {busy ? "Sending..." : q ? `${side === "buy" ? "Buy" : "Sell"} ${fmt(q, 0)} shares` : "Enter an amount"}
        </Button>
      ) : (
        <ConnectPrompt />
      )}
      <p className="note">Fills on the {gpuLabel} shares / USDC order book on the XRP Ledger DEX.</p>
    </div>
  );
}

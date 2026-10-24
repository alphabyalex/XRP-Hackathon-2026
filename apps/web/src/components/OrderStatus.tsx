"use client";
import { useEffect, useState } from "react";
import { fmt, shortHash } from "@/lib/format";
import { fmtEta, fmtTime, getOrder, orderEventsUrl, providerName, type Order } from "@/lib/routerApi";
import "./router.css";

const STATUS: Record<string, string> = {
  created: "Placing",
  paid: "Starting",
  running: "Running",
  completed: "Complete",
  settled: "Complete",
  failed: "Not completed",
};

// The order after payment: where it runs, price, ETA, payment link, live progress, and any move.
export function OrderStatus({ initial }: { initial: Order }) {
  const [order, setOrder] = useState<Order>(initial);

  useEffect(() => {
    const id = initial.orderId;
    const es = new EventSource(orderEventsUrl(id));
    const refresh = () => getOrder(id).then(setOrder).catch(() => undefined);
    es.addEventListener("progress", (e) => {
      const p = JSON.parse((e as MessageEvent).data);
      setOrder((o) => ({ ...o, progress: { ...o.progress, done: p.done, total: p.total, pct: p.pct } }));
    });
    for (const kind of ["paid", "running", "moved", "completed", "settled", "failed"]) {
      es.addEventListener(kind, () => {
        refresh();
        if (kind === "settled" || kind === "failed") es.close();
      });
    }
    es.onerror = () => {
      es.close();
      refresh();
    };
    return () => es.close();
  }, [initial.orderId]);

  const running = order.segments.length ? order.segments.filter((s) => !s.endedAt) : [];
  const where = (running.length ? running : order.segments.length ? order.segments : [])
    .map((s) => `${s.label} · ${providerName(s.provider)}`);
  const planned = (order.plan.parts ?? []).map((p) => `${p.label} · ${providerName(p.provider)}`);
  const gpus = [...new Set(where.length ? where : planned)];
  const done = order.status === "completed" || order.status === "settled";

  return (
    <div className="os">
      <div className="line">
        <span>{gpus.length > 1 ? "GPUs" : "GPU"}</span>
        <b>{gpus.join(", ")}</b>
      </div>
      <div className="line">
        <span>Price</span>
        <b>{fmt(Number(order.priceUsdc), 4)} USDC</b>
      </div>
      <div className="line">
        <span>{done ? "Status" : "ETA"}</span>
        <b>{done || order.status === "failed" ? STATUS[order.status] : fmtEta(order.etaSeconds)}</b>
      </div>
      {order.payment?.hash && (
        <div className="line">
          <span>Payment</span>
          <b>
            <a href={order.payment.explorerUrl ?? "#"} target="_blank" rel="noreferrer">
              {shortHash(order.payment.hash)}
            </a>
          </b>
        </div>
      )}
      <div className="bar" aria-label="Progress">
        <i style={{ width: `${done ? 100 : order.progress.pct}%` }} />
      </div>
      {order.moves.map((m) => (
        <div className="moved" key={`${m.at}-${m.to}`}>
          Moved to {m.toLabel}, resumed<span>{fmtTime(m.at)}</span>
        </div>
      ))}
    </div>
  );
}

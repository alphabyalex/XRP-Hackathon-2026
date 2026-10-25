"use client";
import { useEffect, useState } from "react";
import { usdc } from "@/lib/format";
import { cancelOrder, fmtEta, fmtTime, getOrder, orderEventsUrl, raiseCap, type Order } from "@/lib/routerApi";
import { Button } from "./Button";
import { useToast } from "./Toast";
import "./router.css";

const STATUS: Record<string, string> = {
  created: "Placing",
  paid: "Starting",
  running: "Running",
  paused: "Paused at your price cap",
  completed: "Complete",
  settled: "Complete",
  cancelled: "Cancelled",
  failed: "Not completed",
};

function TxLinks({ links }: { links: (string | null | undefined)[] }) {
  const urls = links.filter((u): u is string => !!u);
  if (!urls.length) return null;
  return (
    <span className="os-tx">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer">
          View transaction
        </a>
      ))}
    </span>
  );
}

// The task after it is placed: where it runs, the estimate and cap, live
// progress, any move, and at the end what was charged and what came back.
export function OrderStatus({ initial }: { initial: Order }) {
  const [order, setOrder] = useState<Order>(initial);
  const [busy, setBusy] = useState<null | "raise" | "cancel">(null);
  const toast = useToast();

  useEffect(() => {
    const id = initial.orderId;
    const es = new EventSource(orderEventsUrl(id));
    const refresh = () => getOrder(id).then(setOrder).catch(() => undefined);
    es.addEventListener("progress", (e) => {
      const p = JSON.parse((e as MessageEvent).data);
      setOrder((o) => ({ ...o, progress: { ...o.progress, done: p.done, total: p.total, pct: p.pct } }));
    });
    for (const kind of ["paid", "running", "moved", "paused", "resumed", "capRaised", "cancelled", "completed", "settled", "failed"]) {
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
  // Tasks run on Moonshift's own GPUs, so the GPU's name is the whole answer.
  const where = (running.length ? running : order.segments.length ? order.segments : []).map((s) => s.label);
  const planned = (order.plan.parts ?? []).map((p) => p.label);
  const gpus = [...new Set(where.length ? where : planned)];
  const settled = order.status === "settled" || (order.status === "cancelled" && order.charged != null);
  const finished = settled || order.status === "completed" || order.status === "failed" || order.status === "cancelled";
  const cap = Number(order.capUsdc ?? order.priceUsdc);
  const charged = Number(order.charged ?? 0);
  const refunded = Number(order.refund?.amountUsdc ?? 0);

  async function raise() {
    if (!order.pause) return;
    setBusy("raise");
    try {
      // Enough for what is left, plus the same 25% headroom.
      const next = Number(order.pause.spentUsdc) + Number(order.pause.neededUsdc) * 1.25;
      setOrder(await raiseCap(order.orderId, Math.max(next, cap * 1.1)));
    } catch (e) {
      toast("Cap not raised", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      setOrder(await cancelOrder(order.orderId));
    } catch (e) {
      toast("Task not cancelled", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="os">
      <div className="line">
        <span>{gpus.length > 1 ? "GPUs" : "GPU"}</span>
        <b>{gpus.join(", ")}</b>
      </div>
      <div className="line">
        <span>Estimate</span>
        <b>
          {usdc(order.estimateUsdc ?? order.priceUsdc)} USDC · at most {usdc(cap)} USDC
        </b>
      </div>
      <div className="line">
        <span>{finished ? "Status" : order.status === "paused" ? "Status" : "ETA"}</span>
        <b>{finished || order.status === "paused" ? STATUS[order.status] : fmtEta(order.etaSeconds)}</b>
      </div>
      {order.payment?.hash && (
        <div className="line">
          <span>Set aside {usdc(order.payment && "amountUsdc" in order.payment ? (order.payment as { amountUsdc: string }).amountUsdc : cap)} USDC</span>
          <b>
            <TxLinks links={[order.payment.explorerUrl, ...(order.topUps ?? []).map((t) => t.explorerUrl)]} />
          </b>
        </div>
      )}
      <div className="bar" aria-label="Progress">
        <i style={{ width: `${settled || order.status === "completed" ? 100 : order.progress.pct}%` }} />
      </div>
      {order.moves.map((m) => (
        <div className="moved" key={`${m.at}-${m.to}`}>
          Moved to {m.toLabel}, resumed<span>{fmtTime(m.at)}</span>
        </div>
      ))}
      {order.status === "paused" && order.pause && (
        <div className="os-pause">
          <p className="note">
            Spent {usdc(order.pause.spentUsdc)} of {usdc(order.pause.capUsdc)} USDC. Finishing needs about {usdc(order.pause.neededUsdc)} USDC more.
          </p>
          <div className="two">
            <Button size="sm" disabled={!!busy} onClick={raise}>
              {busy === "raise" ? "Raising..." : "Raise the cap"}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={cancel}>
              {busy === "cancel" ? "Cancelling..." : "Cancel and refund"}
            </Button>
          </div>
        </div>
      )}
      {(order.status === "running" || order.status === "paid") && (
        <button type="button" className="linkish" disabled={!!busy} onClick={cancel}>
          {busy === "cancel" ? "Cancelling..." : "Cancel task"}
        </button>
      )}
      {settled && (
        <p className="note os-settled">
          Charged {usdc(charged)} USDC · Refunded {usdc(refunded)} USDC{" "}
          <TxLinks links={[...order.settlements.map((s) => s.explorerUrl), order.refund?.explorerUrl]} />
        </p>
      )}
    </div>
  );
}

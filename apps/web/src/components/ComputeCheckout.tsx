"use client";
import { useEffect, useState } from "react";
import { Segmented } from "./Segmented";
import { RouteOptions } from "./RouteOptions";
import { OrderStatus } from "./OrderStatus";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { fmt } from "@/lib/format";
import { createOrder, quote as getQuote, type Mode, type Order, type Quote } from "@/lib/routerApi";
import { ACCOUNT } from "@/lib/session";

type Minutes = "15" | "30" | "60";

// Rent GPU time: pick how long and how to route it; the router places it on the best GPU(s).
export function ComputeCheckout() {
  const [minutes, setMinutes] = useState<Minutes>("30");
  const [mode, setMode] = useState<Mode>("balanced");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    const load = () =>
      getQuote({ kind: "rental", minutes: Number(minutes) })
        .then((q) => live && setQuote(q))
        .catch(() => live && setQuote(null));
    setQuote(null);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [minutes]);

  const plan = quote?.options[mode];

  async function rent() {
    if (busy || !plan?.feasible) return;
    setBusy(true);
    try {
      setOrder(await createOrder({ kind: "rental", minutes: Number(minutes), mode, buyer: ACCOUNT }));
    } catch (err) {
      toast("Rental failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (order) {
    return (
      <div>
        <OrderStatus initial={order} />
        <Button variant="ghost" onClick={() => setOrder(null)}>
          New rental
        </Button>
      </div>
    );
  }

  return (
    <div>
      <span className="lbl">Duration</span>
      <Segmented
        options={[
          { value: "15", label: "15 min" },
          { value: "30", label: "30 min" },
          { value: "60", label: "1 hour" },
        ]}
        value={minutes}
        onChange={setMinutes}
      />
      <RouteOptions quote={quote} value={mode} onChange={setMode} />
      <Button disabled={busy || !plan?.feasible} onClick={rent}>
        {plan?.feasible ? `Rent for ${fmt(Number(plan.priceUsdc), 4)} USDC` : "Rent"}
      </Button>
    </div>
  );
}

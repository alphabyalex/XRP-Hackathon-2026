"use client";
import { useEffect, useState } from "react";
import { getPortfolio } from "@/lib/api";
import { ACCOUNT } from "@/lib/session";
import { fmt } from "@/lib/format";
import { useLiveGpus } from "@/lib/liveData";

// Live USDC balance for the demo persona, shown in the app window title bar.
// Refetches whenever live GPU data changes (trades, bookings) and every 15s.
export function AccountBalance() {
  const [bal, setBal] = useState<number | null>(null);
  const gpus = useLiveGpus();

  useEffect(() => {
    let alive = true;
    const load = () =>
      getPortfolio(ACCOUNT)
        .then((p) => alive && setBal(Number(p.tdxBalance) || 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [gpus]);

  return <b>{bal === null ? "..." : fmt(bal, 2)}</b>;
}

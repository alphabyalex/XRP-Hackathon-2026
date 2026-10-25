"use client";
import { useEffect, useState } from "react";
import { getPortfolio } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useLiveGpus } from "@/lib/liveData";
import { shortAddress, useWallet } from "@/lib/wallet";

// The signed-in wallet and its live USDC balance, for the app window title bar.
// Refetches whenever live GPU data changes (trades, bookings) and every 15s.
export function AccountBalance() {
  const { wallet } = useWallet();
  const [bal, setBal] = useState<number | null>(null);
  const gpus = useLiveGpus();

  useEffect(() => {
    if (!wallet) return setBal(null);
    let alive = true;
    const load = () =>
      getPortfolio()
        .then((p) => alive && setBal(Number(p.tdxBalance) || 0))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [gpus, wallet]);

  if (!wallet) return <>Not connected</>;
  return (
    <>
      {shortAddress(wallet.address)}&nbsp;&nbsp;<b>{bal === null ? "..." : fmt(bal, 2)}</b> USDC
    </>
  );
}

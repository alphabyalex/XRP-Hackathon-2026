"use client";
// "Data via Quicknode · ledger 12,345,678" on the credit panel. The credit
// service reads server_info and ledger closes through Quicknode and sends a
// NETWORK_STATUS credit event every 15 s (relayed by the api's /events).
// Before the first one arrives, the line names the source only.
import { useEffect, useState } from "react";
import { fmt } from "@/lib/format";
import { useApiEvents } from "@/lib/lendingApi";

type Status = { ledgerIndex: number; feeXrp?: string | null; at: number };

export function NetworkLine() {
  const [s, setS] = useState<Status | null>(null);
  const [flash, setFlash] = useState(false);

  useApiEvents(["credit"], (_t, d) => {
    if (d?.kind !== "NETWORK_STATUS") return;
    const i = Number(d.ledgerIndex);
    if (!(i > 0)) return;
    setS((prev) => (prev && prev.ledgerIndex >= i ? prev : { ledgerIndex: i, feeXrp: d.feeXrp ?? null, at: Date.now() }));
    setFlash(true);
  });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <span className={flash ? "bw-net flash" : "bw-net"}>
      Data via Quicknode{s ? ` · ledger ${fmt(s.ledgerIndex, 0)}` : ""}
    </span>
  );
}

"use client";
import { AccountBalance } from "./AccountBalance";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { AppWindow } from "./AppWindow";
import { MarketTable } from "./MarketTable";
import { ApiErrorNotice } from "./ApiErrorNotice";

export function MarketContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Two GPUs, trading now.</h2>
          <p>Each one is an NVIDIA T4 running on AWS. Prices come from the order book on the XRP Ledger DEX. Yield is last 24 hours of payouts, annualized.</p>
        </div>
        {unreachable && <ApiErrorNotice />}
        <AppWindow tabs={["Market", "Portfolio", "Borrow", "Playground"]} activeTab="Market" acct={<AccountBalance />}>
          <div className="tbl">
            <MarketTable views={views} />
          </div>
        </AppWindow>
      </div>
    </main>
  );
}

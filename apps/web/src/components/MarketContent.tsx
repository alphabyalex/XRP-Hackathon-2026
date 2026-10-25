"use client";
import { AccountBalance } from "./AccountBalance";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { AppWindow } from "./AppWindow";
import { MarketTable } from "./MarketTable";
import { ResourcePricingBreakdown } from "./ResourcePricingBreakdown";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { GpuMarketPrices } from "./GpuMarketPrices";
import { ComputeCheckout } from "./ComputeCheckout";

export function MarketContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Two GPUs, earning now.</h2>
          <p>Prices come from the order book on the XRP Ledger DEX. Yield is the last 24 hours of payouts, annualized.</p>
        </div>
        {unreachable && <ApiErrorNotice />}
        <AppWindow tabs={["Market", "Portfolio", "Borrow", "Playground"]} activeTab="Market" acct={<AccountBalance />}>
          <div className="tbl">
            <MarketTable views={views} />
          </div>
        </AppWindow>
        <GpuMarketPrices />
        <h3 className="sub-h">Run a task</h3>
        <div className="trade rent-card" style={{ marginTop: 20 }}>
          <ComputeCheckout />
        </div>
        <ResourcePricingBreakdown />
      </div>
    </main>
  );
}

"use client";
import { useState } from "react";
import { AccountBalance } from "./AccountBalance";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { AppWindow } from "./AppWindow";
import { MarketTable } from "./MarketTable";
import { RentTabContent } from "./RentTabContent";
import { AccountPortfolio } from "./AccountPortfolio";
import { BorrowPanel } from "./BorrowPanel";
import { PlaygroundTry } from "./PlaygroundTry";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { GpuMarketPrices } from "./GpuMarketPrices";
import { ComputeCheckout } from "./ComputeCheckout";

const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
function gpuCount(n: number): string {
  if (!n) return "Live GPUs, earning now.";
  return `${WORDS[n] ?? n} GPU${n === 1 ? "" : "s"}, earning now.`;
}

export function MarketContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const [activeTab, setActiveTab] = useState<string>("Market");
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));
  const featured = views.find((v) => v.gpu.id === "gpu-a") ?? views[0];

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>{gpuCount(views.length)}</h2>
          <p>Prices come from the order book on the XRP Ledger DEX. Yield is the last 24 hours of payouts, annualized.</p>
        </div>
        {unreachable && <ApiErrorNotice />}
        <AppWindow
          tabs={["Rent", "Market", "Portfolio", "Borrow", "Playground"]}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          acct={<AccountBalance />}
        >
          {activeTab === "Rent" && <RentTabContent checkoutHref="#run-task" />}
          {activeTab === "Market" && (
            <div className="tbl">
              <MarketTable views={views} />
            </div>
          )}
          {activeTab === "Portfolio" && (
            <div style={{ padding: "20px 24px" }}>
              <AccountPortfolio />
            </div>
          )}
          {activeTab === "Borrow" && featured && (
            <div style={{ padding: "24px 28px", maxWidth: 640, margin: "0 auto" }}>
              <BorrowPanel gpuId={featured.gpu.id} gpuLabel={featured.dashLabel} sharePrice={Number(featured.gpu.sharePrice) || 0} />
            </div>
          )}
          {activeTab === "Playground" && (
            <div style={{ padding: "24px 28px", maxWidth: 640, margin: "0 auto" }}>
              <PlaygroundTry />
            </div>
          )}
        </AppWindow>
        <GpuMarketPrices />
        <h3 className="sub-h" id="run-task">
          Run a task
        </h3>
        <div className="trade rent-card" style={{ marginTop: 20 }}>
          <ComputeCheckout />
        </div>
      </div>
    </main>
  );
}

"use client";
import { GPUS } from "@moonshift/shared";
import { useLiveGpus, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { AppWindow } from "./AppWindow";
import { MarketTable } from "./MarketTable";
import { RenterTable } from "./RenterTable";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { Reveal } from "./Reveal";

// Market: renters first (what each GPU costs and how free it is), then the shares of the same GPUs.
export function MarketContent() {
  const gpus = useLiveGpus();
  const now = useNow();
  const unreachable = useApiUnreachable();
  const views = GPUS.map((g) => gpus[g.id]).filter(Boolean).map((g) => gpuView(g, now));

  return (
    <main className="s">
      <div className="wrap">
        <div className="shead">
          <h2>Rent a GPU</h2>
          <p>Pick a GPU, describe your task, and pay by the hour. Prices sit next to what other providers charge for the same card right now.</p>
        </div>
        {unreachable && <ApiErrorNotice />}
        <AppWindow>
          <RenterTable />
        </AppWindow>
        <Reveal>
          <div className="shead" style={{ marginTop: 72, marginBottom: 24 }}>
            <h3 className="sub-h" style={{ margin: 0 }}>
              Own a share
            </h3>
            <p className="sub-p">Each GPU&apos;s shares trade on the XRP Ledger DEX. Yield is the last 24 hours of payouts, annualized.</p>
          </div>
          <AppWindow>
            <div className="tbl">
              <MarketTable views={views} />
            </div>
          </AppWindow>
        </Reveal>
      </div>
    </main>
  );
}

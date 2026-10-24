"use client";
import Link from "next/link";
import clsx from "clsx";
import { useLiveGpu, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { fmt } from "@/lib/format";
import { mockPriceHistory, change24h } from "@/lib/mockPriceHistory";
import { DataMoon } from "./DataMoon";
import { ScheduleRows } from "./ScheduleRows";
import { TradePanel } from "./TradePanel";
import { PriceFlash } from "./PriceFlash";
import { ApiErrorNotice } from "./ApiErrorNotice";

export function GpuDetailContent({ id }: { id: string }) {
  const gpu = useLiveGpu(id);
  const now = useNow();
  const unreachable = useApiUnreachable();

  if (unreachable) {
    return (
      <main className="wrap" style={{ paddingBlock: 120 }}>
        <ApiErrorNotice />
      </main>
    );
  }
  if (!gpu) return null;

  const v = gpuView(gpu, now);
  const price = Number(gpu.sharePrice) || 0;
  const history = mockPriceHistory(gpu.id, price);
  const ch = change24h(history);

  return (
    <main className="s">
      <div className="wrap">
        <p style={{ fontSize: 14, color: "var(--ink2)", marginBottom: 24 }}>
          <Link href="/market">Market</Link> / {v.dashLabel}
        </p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24, flexWrap: "wrap", marginBottom: 48 }}>
          <div className="gname">
            <DataMoon slots={v.slots} size={72} />
            <div>
              <b style={{ fontSize: 28 }}>{v.dashLabel}</b>
              <span>
                {gpu.hw} &middot; {gpu.model}
              </span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="px" style={{ fontSize: 32 }}>
              <PriceFlash value={price} decimals={3} /> <span style={{ fontSize: 16, color: "var(--ink2)" }}>USDC / share</span>
            </div>
            <span className={clsx("chg", ch >= 0 ? "up" : "dn")}>
              {ch >= 0 ? "+" : ""}
              {fmt(ch, 2)}% &middot; 24h
            </span>
          </div>
        </div>

        <div className="sched-grid">
          <div>
            <ScheduleRows slots={v.slots} nowIndex={v.nowIndex} windowStart={v.windowStart} />
            <div className="key">
              <span>
                <i className="k-b" />
                Booked
              </span>
              <span>
                <i className="k-l" />
                Night shift (inference)
              </span>
              <span>
                <i className="k-i" />
                Idle
              </span>
              <span>
                <i className="k-o" />
                Open to book
              </span>
            </div>
            <div className="facts" style={{ marginTop: 40 }}>
              <div>
                <span>Utilization, last 24h</span>
                <b>{fmt(Number(gpu.utilizationPct) || 0, 1)}%</b>
              </div>
              <div>
                <span>Revenue, last 24h</span>
                <b>{fmt(v.revenue24h, 2)} USDC</b>
              </div>
              <div>
                <span>Paid per share, last 24h</span>
                <b>{fmt(v.split.holders / 1000, 6)} USDC</b>
              </div>
              <div>
                <span>NAV per share</span>
                <b>{fmt(Number(gpu.navPerShare) || 0, 3)} USDC</b>
              </div>
              <div>
                <span>Holders</span>
                <b>{gpu.holdersCount}</b>
              </div>
              <div>
                <span>State</span>
                <b style={{ fontSize: 15 }}>{gpu.simulated ? `${gpu.state} (simulated)` : gpu.state}</b>
              </div>
            </div>
          </div>
          <TradePanel
            gpuId={gpu.id}
            gpuLabel={v.dashLabel}
            sharePrice={price}
            revenue24h={v.revenue24h}
            nowIndex={v.nowIndex}
            slots={v.slots}
            windowStart={v.windowStart}
          />
        </div>
      </div>
    </main>
  );
}

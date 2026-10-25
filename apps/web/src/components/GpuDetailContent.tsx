"use client";
import Link from "next/link";
import clsx from "clsx";
import { RESOURCE_BREAKDOWN, type GpuId } from "@moonshift/shared";
import { useLiveGpu, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { fmt } from "@/lib/format";
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
  const ch = Number(gpu.change24hPct ?? 0);

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
                <b style={{ fontSize: 15 }}>{gpu.state}</b>
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

        {RESOURCE_BREAKDOWN[gpu.id as GpuId] && (
          <div style={{ marginTop: 40, padding: 24, background: "var(--surface)", borderRadius: 16, boxShadow: "0 0 0 1px var(--rule)" }}>
            <h3 style={{ fontSize: 18, marginBottom: 8, fontWeight: 600 }}>Hardware Resource Breakdown &amp; Indexing</h3>
            <p style={{ fontSize: 13, color: "var(--ink2)", marginBottom: 16 }}>
              Provider: <b>{RESOURCE_BREAKDOWN[gpu.id as GpuId].provider}</b> &middot; Instance: <b>{RESOURCE_BREAKDOWN[gpu.id as GpuId].instanceType}</b>
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
              <div style={{ padding: 12, background: "var(--tint)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--ink3)" }}>GPU Compute</span>
                <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>{RESOURCE_BREAKDOWN[gpu.id as GpuId].components.gpu.spec}</div>
                <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 2, fontFamily: "var(--mono)" }}>${RESOURCE_BREAKDOWN[gpu.id as GpuId].components.gpu.hourlyUsd}/hr</div>
              </div>
              <div style={{ padding: 12, background: "var(--tint)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--ink3)" }}>vCPU Compute</span>
                <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>{RESOURCE_BREAKDOWN[gpu.id as GpuId].components.cpu.spec}</div>
                <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 2, fontFamily: "var(--mono)" }}>${RESOURCE_BREAKDOWN[gpu.id as GpuId].components.cpu.hourlyUsd}/hr</div>
              </div>
              <div style={{ padding: 12, background: "var(--tint)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--ink3)" }}>System Memory (RAM)</span>
                <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>{RESOURCE_BREAKDOWN[gpu.id as GpuId].components.ram.spec}</div>
                <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 2, fontFamily: "var(--mono)" }}>${RESOURCE_BREAKDOWN[gpu.id as GpuId].components.ram.hourlyUsd}/hr</div>
              </div>
              <div style={{ padding: 12, background: "var(--tint)", borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: "var(--ink3)" }}>NVMe Storage</span>
                <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>{RESOURCE_BREAKDOWN[gpu.id as GpuId].components.storage.spec}</div>
                <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 2, fontFamily: "var(--mono)" }}>${RESOURCE_BREAKDOWN[gpu.id as GpuId].components.storage.hourlyUsd}/hr</div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--rule)", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--ink2)" }}>Total Composite Cost: <b style={{ color: "var(--ink)" }}>${RESOURCE_BREAKDOWN[gpu.id as GpuId].totalHourlyUsd} / hr</b> (${RESOURCE_BREAKDOWN[gpu.id as GpuId].monthlyUsd} / month)</span>
              {RESOURCE_BREAKDOWN[gpu.id as GpuId].indexedSavingsVsAwsPct !== "0.0%" && (
                <span style={{ fontSize: 13, color: "#2e7d32", fontWeight: 600 }}>{RESOURCE_BREAKDOWN[gpu.id as GpuId].indexedSavingsVsAwsPct} Cost Savings vs AWS Baseline</span>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

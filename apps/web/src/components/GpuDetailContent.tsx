"use client";
// One GPU. "Run a task" (default) is the renter's view: the hardware, the hourly price, sizing a
// task and submitting it, and booking a future hour. "Buy shares" is the owner's view of the same
// GPU's share market. ?view=shares opens the second.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useLiveGpu, useApiUnreachable, useNow } from "@/lib/liveData";
import { gpuView } from "@/lib/gpuView";
import { fmt } from "@/lib/format";
import { num, usdHr, whereOf, useCatalog } from "@/lib/catalog";
import type { Mode, TaskType } from "@/lib/routerApi";
import { DataMoon } from "./DataMoon";
import { PriceFlash } from "./PriceFlash";
import { ApiErrorNotice } from "./ApiErrorNotice";
import { Segmented } from "./Segmented";
import { TaskDescribe, type TaskSize } from "./TaskDescribe";
import { ComputeCheckout } from "./ComputeCheckout";
import { BookingCalendar } from "./BookingCalendar";
import { GpuShares } from "./GpuShares";
import { changeOf, fmtChange, priceOf, useGpuStats } from "@/lib/gpuMarket";

type View = "task" | "shares";

export function GpuDetailContent({ id }: { id: string }) {
  const gpu = useLiveGpu(id);
  const now = useNow();
  const unreachable = useApiUnreachable();
  const [view, setView] = useState<View>("task");
  // Read after mount so the static page and hydration agree.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "shares") setView("shares");
  }, []);
  const { data: catalog } = useCatalog();
  const cat = catalog?.gpus.find((g) => g.id === id);
  const { data: stats } = useGpuStats(id);
  const [type, setType] = useState<TaskType>("inference");
  const [mode, setMode] = useState<Mode>("balanced");
  const [size, setSize] = useState<TaskSize | null>(null);
  const onSize = useCallback((s: TaskSize) => setSize(s), []);

  if (unreachable) {
    return (
      <main className="wrap" style={{ paddingBlock: 120 }}>
        <ApiErrorNotice />
      </main>
    );
  }
  if (!gpu) return null;

  const v = gpuView(gpu, now);
  const price = priceOf(stats, gpu.sharePrice);
  const ch = changeOf(stats);
  // Until the catalog answers, use the api's own cost breakdown for this GPU (real hardware only).
  const res = gpu.resources;
  const spec = (s: string | undefined, re: RegExp) => num(re.exec(s ?? "")?.[1]);
  const vcpu = num(cat?.vcpu) ?? spec(res?.components.cpu.spec, /(\d+)\s*vCPU/);
  const ramGb = num(cat?.ramGb) ?? spec(res?.components.ram.spec, /(\d+)\s*GiB/);
  const diskGb = num(cat?.storageGb) ?? spec(res?.components.storage.spec, /(\d+)\s*GB/);
  const hourly = num(cat?.prices.rentalUsdPerHour) ?? num(res?.totalHourlyUsd);
  const where = cat ? whereOf(cat) : res?.provider?.replace(/\s*\(.*\)$/, "") ?? null;
  const gpuHours = size ? (size.gpus * size.durationSeconds) / 3600 : 1;

  return (
    <main className="s">
      <div className="wrap">
        <p style={{ fontSize: 14, color: "var(--ink2)", marginBottom: 24 }}>
          <Link href="/market">Market</Link> / {v.dashLabel}
        </p>

        <div className="gpu-head">
          <div className="gname">
            <DataMoon slots={v.slots} size={72} />
            <div>
              <b style={{ fontSize: 28 }}>{v.dashLabel}</b>
              <span>
                {cat?.card ?? gpu.hw}
                {where ? `, ${where}` : ""}
              </span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {view === "task" ? (
              <>
                <div className="px" style={{ fontSize: 32 }}>
                  {hourly === null ? "–" : <PriceFlash value={hourly} decimals={3} />} <span style={{ fontSize: 16, color: "var(--ink2)" }}>USD / hour</span>
                </div>
                <span className="note" style={{ margin: 0 }}>
                  Price to rent for an hour
                </span>
              </>
            ) : (
              <>
                <div className="px" style={{ fontSize: 32 }}>
                  <PriceFlash value={price} decimals={3} /> <span style={{ fontSize: 16, color: "var(--ink2)" }}>USDC / share</span>
                </div>
                <span className={clsx("chg", ch === null ? undefined : ch >= 0 ? "up" : "dn")}>
                  {fmtChange(ch)} &middot; 24h
                </span>
              </>
            )}
          </div>
        </div>

        <div className="gpu-views">
          <Segmented
            options={[
              { value: "task", label: "Run a task" },
              { value: "shares", label: "Buy shares" },
            ]}
            value={view}
            onChange={(next: View) => {
              setView(next);
              const url = new URL(window.location.href);
              if (next === "shares") url.searchParams.set("view", "shares");
              else url.searchParams.delete("view");
              window.history.replaceState(null, "", url);
            }}
          />
        </div>

        {view === "task" ? (
          <>
            <div className="facts gpu-specs">
              <div>
                <span>Location</span>
                <b>{where ?? "–"}</b>
              </div>
              <div>
                <span>Card</span>
                <b>
                  {cat?.card ?? gpu.hw}
                  {num(cat?.vramGb) !== null ? `, ${cat?.vramGb} GB` : ""}
                </b>
              </div>
              <div>
                <span>vCPU</span>
                <b>{vcpu ?? "–"}</b>
              </div>
              <div>
                <span>RAM</span>
                <b>{ramGb !== null ? `${ramGb} GB` : "–"}</b>
              </div>
              <div>
                <span>Storage</span>
                <b>{diskGb !== null ? `${diskGb} GB` : "–"}</b>
              </div>
              <div>
                <span>Free nodes</span>
                <b>{num(cat?.nodes.free) === null ? "–" : `${cat?.nodes.free} of ${cat?.nodes.total ?? "–"}`}</b>
              </div>
              <div>
                <span>Price to rent for an hour</span>
                <b>{usdHr(hourly)}</b>
              </div>
            </div>
            <div className="task-grid">
              <div className="trade">
                <TaskDescribe gpu={cat} type={type} onType={setType} mode={mode} onSize={onSize} />
              </div>
              <div className="trade">
                <ComputeCheckout task={{ type, gpuHours }} onMode={setMode} />
              </div>
            </div>
            <h3 className="sub-h">Book an hour</h3>
            <p className="sub-p">The next 7 days of {v.dashLabel}. Pick a free hour and it is yours, paid up front on the ledger.</p>
            <div className="trade" style={{ marginTop: 20 }}>
              <BookingCalendar gpuId={gpu.id} gpuLabel={v.dashLabel} pricePerHour={hourly} />
            </div>
          </>
        ) : (
          <GpuShares gpu={gpu} view={v} />
        )}
      </div>
    </main>
  );
}

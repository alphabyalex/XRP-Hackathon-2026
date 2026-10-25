"use client";
import Link from "next/link";
import clsx from "clsx";
import type { GpuView } from "@/lib/gpuView";
import { DataMoon } from "./DataMoon";
import { MiniSchedule } from "./MiniSchedule";
import { PriceFlash } from "./PriceFlash";
import { fmt } from "@/lib/format";
import { changeOf, fmtChange, priceOf, useStatsMap, yieldOf } from "@/lib/gpuMarket";

// Ported from the market() function's table rows in moonshift_v2_source.html.
export function MarketTable({ views }: { views: GpuView[] }) {
  const stats = useStatsMap(views.map((v) => v.gpu.id));
  return (
    <table>
      <thead>
        <tr>
          <th>GPU</th>
          <th>Last 24 hours</th>
          <th className="r">Price</th>
          <th className="r">24h</th>
          <th className="r">Yield</th>
          <th className="r">Holders</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {views.map((v) => {
          // One price everywhere: GET /gpus/:id/stats.
          const st = stats[v.gpu.id];
          const price = priceOf(st, v.gpu.sharePrice);
          const ch = changeOf(st);
          const yld = yieldOf(st, v.gpu.impliedYieldPct);
          return (
            <tr key={v.gpu.id}>
              <td>
                <div className="gname">
                  <DataMoon slots={v.slots.slice(-288)} size={40} />
                  <div>
                    <b>{v.dashLabel}</b>
                    <span>{v.gpu.hw}</span>
                  </div>
                </div>
              </td>
              <td>
                <MiniSchedule slots={v.slots.slice(-288)} />
              </td>
              <td className="r px">
                <PriceFlash value={price} decimals={3} />
              </td>
              <td className="r">
                <span className={clsx("chg", ch === null ? undefined : ch >= 0 ? "up" : "dn")}>{fmtChange(ch)}</span>
              </td>
              <td className="r num">{yld === null ? "–" : `${fmt(yld, 1)}%`}</td>
              <td className="r num">{st?.holders ?? v.gpu.holdersCount}</td>
              <td className="r">
                <Link className="btn ghost sm" href={`/gpu/${v.gpu.id}?view=shares`}>
                  Trade
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

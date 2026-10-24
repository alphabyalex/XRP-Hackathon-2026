import Link from "next/link";
import clsx from "clsx";
import type { GpuView } from "@/lib/gpuView";
import { DataMoon } from "./DataMoon";
import { MiniSchedule } from "./MiniSchedule";
import { PriceFlash } from "./PriceFlash";
import { fmt } from "@/lib/format";
import { mockPriceHistory, change24h } from "@/lib/mockPriceHistory";

// Ported from the market() function's table rows in moonshift_v2_source.html.
export function MarketTable({ views }: { views: GpuView[] }) {
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
          const price = Number(v.gpu.sharePrice) || 0;
          const history = mockPriceHistory(v.gpu.id, price);
          const ch = change24h(history);
          return (
            <tr key={v.gpu.id}>
              <td>
                <div className="gname">
                  <DataMoon slots={v.slots.slice(-288)} size={40} />
                  <div>
                    <b>{v.dashLabel}</b>
                    <span>{v.gpu.hw}</span>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                      <span style={{ fontSize: 11, padding: "1px 5px", background: "var(--tint)", borderRadius: 4, color: "var(--ink2)", fontFamily: "var(--mono)" }}>
                        1x T4 16GB
                      </span>
                      <span style={{ fontSize: 11, padding: "1px 5px", background: "var(--tint)", borderRadius: 4, color: "var(--ink2)", fontFamily: "var(--mono)" }}>
                        4 vCPU
                      </span>
                      <span style={{ fontSize: 11, padding: "1px 5px", background: "var(--tint)", borderRadius: 4, color: "var(--ink2)", fontFamily: "var(--mono)" }}>
                        16 GB RAM
                      </span>
                      <span style={{ fontSize: 11, padding: "1px 5px", background: "var(--tint)", borderRadius: 4, color: "var(--ink2)", fontFamily: "var(--mono)" }}>
                        {v.gpu.id === "gpu-a" ? "125 GB NVMe" : "100 GB NVMe"}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 3, fontFamily: "var(--mono)" }}>
                      {v.gpu.id === "gpu-a"
                        ? "Indexed Cost: $0.526/hr (AWS On-Demand)"
                        : "Indexed Cost: $0.160/hr (Akash Spot - 69.6% savings)"}
                    </div>
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
                <span className={clsx("chg", ch >= 0 ? "up" : "dn")}>
                  {ch >= 0 ? "+" : ""}
                  {fmt(ch, 2)}%
                </span>
              </td>
              <td className="r num">{fmt(Number(v.gpu.impliedYieldPct) || 0, 1)}%</td>
              <td className="r num">{v.gpu.holdersCount}</td>
              <td className="r">
                <Link className="btn ghost sm" href={`/gpu/${v.gpu.id}`}>
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

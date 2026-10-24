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
        <tr className="soon">
          <td>
            <div className="gname">
              <svg width={40} height={40} viewBox="0 0 100 100" aria-hidden="true">
                <circle cx={50} cy={50} r={43} fill="none" stroke="var(--rule2)" strokeWidth={2} strokeDasharray="5 5" />
              </svg>
              <div>
                <b>L4 &middot; 24 GB</b>
                <span>us-east-1</span>
              </div>
            </div>
          </td>
          <td>Listing in November</td>
          <td />
          <td />
          <td />
          <td />
          <td />
        </tr>
      </tbody>
    </table>
  );
}

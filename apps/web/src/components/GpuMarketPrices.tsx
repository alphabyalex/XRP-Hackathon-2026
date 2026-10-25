"use client";
import { useCallback, useEffect, useState } from "react";
import type { GpuMarketPrice, GpuMarketPricesResponse } from "@moonshift/shared";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/lib/format";
import { PriceFlash } from "./PriceFlash";

const ROWS = 8;

// The most widely offered GPUs with a clear model name, by provider count.
function topGpus(gpus: GpuMarketPrice[]): GpuMarketPrice[] {
  return gpus
    .filter((g) => g.rentalUsdPerHour !== null && !/not stated/i.test(g.name))
    .sort((a, b) => b.providers - a.providers)
    .slice(0, ROWS);
}

function weekChange(g: GpuMarketPrice): number | null {
  const h = g.weeklyHistory;
  if (h.length < 2) return null;
  const before = Number(h[h.length - 2].price);
  const now = Number(h[h.length - 1].price);
  return before > 0 ? (now / before - 1) * 100 : null;
}

// What the same GPUs rent for elsewhere, for comparison with the Moonshift GPUs above.
export function GpuMarketPrices() {
  const [data, setData] = useState<GpuMarketPricesResponse | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await apiFetch<GpuMarketPricesResponse>("/gpu-prices"));
    } catch {
      // keep the last table
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return null;
  return (
    <section aria-labelledby="gpu-prices-heading" data-testid="gpu-market-prices">
      <h3 className="sub-h" id="gpu-prices-heading">
        GPU rental prices
      </h3>
      <div className="tbl gpu-rent">
        <table>
          <thead>
            <tr>
              <th>GPU</th>
              <th className="r">Memory</th>
              <th className="r">USD / GPU-hour</th>
              <th className="r">Week</th>
              <th className="r">Providers</th>
            </tr>
          </thead>
          <tbody>
            {topGpus(data.gpus).map((g) => {
              const wk = weekChange(g);
              return (
                <tr key={g.id}>
                  <td>{g.name.replace(/^NVIDIA /, "")}</td>
                  <td className="r num">{g.vramGb} GB</td>
                  <td className="r num">
                    <PriceFlash value={Number(g.rentalUsdPerHour)} decimals={2} />
                  </td>
                  <td className={`r num ${wk === null ? "" : wk >= 0 ? "up" : "dn"}`}>{wk === null ? "" : `${wk >= 0 ? "+" : ""}${fmt(wk, 1)}%`}</td>
                  <td className="r num">{g.providers}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        On-demand rates, median across providers.{" "}
        <a href={data.source.url} target="_blank" rel="noreferrer">
          {data.source.name}
        </a>
      </p>
    </section>
  );
}

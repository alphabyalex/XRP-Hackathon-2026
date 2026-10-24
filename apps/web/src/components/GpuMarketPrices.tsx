"use client";
import { useCallback, useEffect, useState } from "react";
import type { GpuMarketPricesResponse } from "@moonshift/shared";
import { apiFetch } from "@/lib/api";
import { PriceFlash } from "./PriceFlash";
import { Button } from "./Button";
import { Segmented } from "./Segmented";
import { HistoryChart } from "./HistoryChart";

const WATCHLIST = ["t4", "l4", "rtx-4090", "a100-40", "a100-80", "h100-sxm", "h200"];
const timestamp = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));

export function GpuMarketPrices() {
  const [data, setData] = useState<GpuMarketPricesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("h100-sxm");
  const [period, setPeriod] = useState("weekly");
  const refresh = useCallback(async () => {
    try { setData(await apiFetch<GpuMarketPricesResponse>("/gpu-prices")); setFailed(false); }
    catch { setFailed(true); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 60000); return () => clearInterval(timer); }, [refresh]);
  const gpu = data?.gpus.find(g => g.id === selected) ?? data?.gpus[0];
  const useWeeks = period === "weekly";
  const points = gpu ? useWeeks
    ? gpu.weeklyHistory.map(p => ({ time: p.date + "T00:00:00Z", value: Number(p.price) }))
    : gpu.observations.filter(p => p.rentalUsdPerHour !== null)
      .map(p => ({ time: p.time, value: Number(p.rentalUsdPerHour) })) : [];
  const watchlist = data ? [...new Set([...WATCHLIST, selected])].flatMap(id => { const row = data.gpus.find(g => g.id === id); return row ? [row] : []; }) : [];
  return <section aria-labelledby="gpu-prices-heading" data-testid="gpu-market-prices">
    <h2 id="gpu-prices-heading">GPU rental prices</h2>
    <div className="portfolio-controls"><p className="account-muted">On-demand rental · USD per GPU-hour</p>
      <label>GPU <select aria-label="GPU price model" value={gpu?.id ?? selected} onChange={event => setSelected(event.target.value)}>
        {data?.gpus.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}
      </select></label>
    </div>
    {failed && <div className="portfolio-price-notice" role="status">Price updates are unavailable. <Button variant="ghost" size="sm" onClick={() => void refresh()}>Try again</Button></div>}
    {!data ? !failed && <div className="account-skeleton account-chart-skeleton" aria-label="Loading GPU prices"/> : <>
      {(data.stale || data.historyStale) && <p className="portfolio-price-notice">{data.stale ? "Prices are delayed" : "History updates are delayed"}</p>}
      <div className="portfolio-price-top"><div className="portfolio-price-quote"><h3>{gpu?.name}</h3>
        <p>{gpu && gpu.rentalUsdPerHour !== null ? <>$<PriceFlash value={Number(gpu.rentalUsdPerHour)} decimals={4}/><span>/hour</span></> : <span>No published price</span>}</p>
      </div><Segmented options={[{ value: "weekly", label: "Weekly history" }, { value: "observed", label: "Tracked 7D" }]} value={period} onChange={setPeriod}/></div>
      <HistoryChart lines={gpu ? [{ key: gpu.id, label: gpu.name, points }] : []} label={`${gpu?.name ?? "GPU"} rental price history`} unit="USD/hour"/>
      <div className="portfolio-price-meta"><span>{useWeeks ? "Weekly provider medians" : "Recorded source prices"}</span>
        {gpu && <a href={gpu.sourceUrl} target="_blank" rel="noreferrer">Source prices ↗</a>}
      </div>
      <div className="account-table-scroll"><table className="account-table portfolio-market-table"><thead><tr><th>GPU</th><th>Memory</th><th>USD/hour</th><th>Providers</th></tr></thead>
        <tbody>{watchlist.map(g => <tr key={g.id} className={g.id === gpu?.id ? "portfolio-selected-row" : undefined}>
          <td><button onClick={() => setSelected(g.id)}>{g.name}</button></td><td>{g.vramGb} GB</td>
          <td>{g.rentalUsdPerHour === null ? "Unavailable" : <PriceFlash value={Number(g.rentalUsdPerHour)} decimals={4}/>}</td>
          <td>{g.providers}</td></tr>)}</tbody></table></div>
      <div className="portfolio-source"><a href={data.source.url} target="_blank" rel="noreferrer">Data: {data.source.name}</a>
        <span>Source updated {timestamp(data.sourceUpdatedAt)}</span><span>Checks every {Math.round(data.refreshSeconds / 60)} min</span></div>
    </>}
  </section>;
}

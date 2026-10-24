"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountReturnsResponse } from "@moonshift/shared";
import { apiFetch } from "@/lib/api";
import { ACCOUNT } from "@/lib/session";
import { useApiEvents } from "@/lib/lendingApi";
import { fmt } from "@/lib/format";
import { Segmented } from "./Segmented";
import { HistoryChart } from "./HistoryChart";

export function PortfolioReturns() {
  const [days, setDays] = useState("30");
  const [gpu, setGpu] = useState("All");
  const [data, setData] = useState<AccountReturnsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const result = await apiFetch<AccountReturnsResponse>(`/account/${encodeURIComponent(ACCOUNT)}/returns?days=${days}`);
      if (sequence === request.current) { setData(result); setFailed(false); }
    } catch { if (sequence === request.current) setFailed(true); }
  }, [days]);
  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => { request.current++; clearInterval(timer); };
  }, [days, refresh]);
  useApiEvents(["dividend", "tx", "loan"], () => void refresh());
  const selected = data?.series.filter(s => gpu === "All" || s.gpuId === gpu) ?? [];
  const total = selected.reduce((sum, s) => sum + Number(s.totalEarned), 0);
  return <section aria-labelledby="returns-heading" data-testid="portfolio-returns">
    <div className="account-section-head"><h2 id="returns-heading">Your returns</h2>
      <Segmented options={[{ value: "7", label: "7D" }, { value: "30", label: "30D" }, { value: "90", label: "90D" }]} value={days} onChange={setDays}/>
    </div>
    <div className="portfolio-controls"><p className="account-muted">Dividends received · USDC</p>
      <label>GPU <select aria-label="Returns GPU" value={gpu} onChange={event => setGpu(event.target.value)}>
        <option value="All">All GPUs</option>{data?.series.map(s => <option value={s.gpuId} key={s.gpuId}>{s.label}</option>)}
      </select></label>
    </div>
    {!data ? failed ? <p className="account-muted">Returns are temporarily unavailable</p> : <div className="account-skeleton account-chart-skeleton" aria-label="Loading returns"/> : <>
      <p className="portfolio-return-total account-income">+{fmt(total, 2)} <span>USDC</span></p>
      <HistoryChart label="Cumulative dividends received over time" unit="USDC" zeroBaseline lines={selected.map((s, i) => ({
        key: s.gpuId, label: s.label, points: s.days.map(d => ({ time: d.date + "T00:00:00Z", value: Number(d.cumulative) })),
        color: i === 0 ? "var(--accent-ink)" : "var(--ink2)", dashed: i > 0,
      }))}/>
      <div className="account-table-scroll"><table className="account-table portfolio-return-table"><thead><tr><th>GPU</th><th>Hardware</th><th>Received {days}d</th></tr></thead>
        <tbody>{selected.map(s => <tr key={s.gpuId}><td>{s.label}</td><td>{s.hardware}</td><td className="account-income">+{fmt(Number(s.totalEarned), 2)} USDC</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}

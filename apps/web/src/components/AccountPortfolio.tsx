"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AccountResponse } from "@moonshift/shared";
import { apiFetch } from "@/lib/api";
import { ACCOUNT } from "@/lib/session";
import { payOff, useApiEvents } from "@/lib/lendingApi";
import { fmt } from "@/lib/format";
import { Button } from "./Button";
import { DataMoon } from "./DataMoon";
import { PriceFlash } from "./PriceFlash";
import { Segmented } from "./Segmented";
import { HealthMeter } from "./LendingBits";
import { useToast } from "./Toast";
import { PortfolioReturns } from "./PortfolioReturns";
import { GpuMarketPrices } from "./GpuMarketPrices";

const short = (s: string) => { const value=s.replace(/^MOCK(?:_ADDR_)?/, ""); return value.length>14 ? `${value.slice(0,6)}…${value.slice(-4)}` : value; };
const money = (s: string | number) => fmt(Number(s),2);
const date = (s: string) => new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:"America/New_York"}).format(new Date(s));

export function AccountPortfolio() {
  const [data,setData]=useState<AccountResponse|null>(null);
  const [error,setError]=useState(false);
  const [deferred,setDeferred]=useState(false);
  const [selection,setSelection]=useState("All");
  const [visible,setVisible]=useState(15);
  const [busy,setBusy]=useState<string|null>(null);
  const [hover,setHover]=useState<number|null>(null);
  const [inView,setInView]=useState(false);
  const chart=useRef<HTMLDivElement>(null);
  const fetching=useRef(false);
  const queued=useRef(false);
  const toast=useToast();
  const refresh=useCallback(async()=>{
    if(fetching.current){queued.current=true;return;}
    fetching.current=true;
    try{const next=await apiFetch<AccountResponse>(`/account/${encodeURIComponent(ACCOUNT)}`);setData(next);setError(false);}
    catch{setError(true);}
    finally{fetching.current=false;if(queued.current){queued.current=false;void refresh();}}
  },[]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>clearInterval(timer);},[refresh]);
  useApiEvents(["dividend","tx","loan","risk","calendar"],()=>void refresh());
  useEffect(()=>{if(data){const timer=setTimeout(()=>setDeferred(true),0);return()=>clearTimeout(timer);}},[data]);
  useEffect(()=>{if(!chart.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setInView(true);observer.disconnect();}},{threshold:0.15});observer.observe(chart.current);return()=>observer.disconnect();},[deferred,data?.holdings.length]);
  async function repay(id:string){
    setBusy(id);
    try{const loan=await payOff(id);toast("Loan repaid",Object.entries(loan.txs).filter(([key])=>key.startsWith("pay")).map(([,hash])=>hash).join(" · "));await refresh();}
    catch{toast("Repayment unavailable","Please try again.");}finally{setBusy(null);}
  }
  const held=data?.holdings??[];
  const active=selection==="All" ? held : held.filter(h=>h.gpuId===selection);
  const performance=(data?.gpuPerformance??[]).filter(p=>active.some(h=>h.gpuId===p.gpuId));
  const days=[...new Set(performance.flatMap(p=>p.days.map(d=>d.date)))].sort().slice(-7).map(day=>({date:day,booked:performance.reduce((sum,p)=>sum+Number(p.days.find(d=>d.date===day)?.booked??0),0),inference:performance.reduce((sum,p)=>sum+Number(p.days.find(d=>d.date===day)?.inference??0),0)}));
  const max=Math.max(1,...days.map(d=>d.booked+d.inference));
  const revenue=performance.reduce((s,p)=>s+Number(p.revenue24h),0);
  const utilization=performance.length ? performance.reduce((s,p)=>s+Number(p.utilization24h),0)/performance.length : 0;
  const ownership=active.reduce((s,h)=>s+Number(h.ownershipPct),0);
  const earned=active.reduce((s,h)=>s+Number(h.earned7d),0);
  const options=[...(held.length>1?[{value:"All",label:"All"}]:[]),...held.map(h=>({value:h.gpuId,label:h.label}))];
  const selected=selection==="All" && held.length===1 ? held[0].gpuId : selection;
  return <main className="wrap account-portfolio">
    <header className="account-header">
      <div><p className="account-eyebrow">Portfolio</p>
        {data?<h1 className="bignum" data-testid="net-worth">{money(data.totals.totalValue)} <span>USDC</span></h1>:<div className="account-skeleton account-total" aria-label="Loading portfolio"/>}
        {data?<div className="account-inline"><span>USDC <b>{money(data.balances.usdc)}</b></span><span>XRP <b>{money(data.balances.xrp)}</b></span><span>Earned this week <b className="account-income">+{money(data.totals.earned7d)}</b></span></div>:<div className="account-skeleton"/>}
      </div>
      {data && <div className="account-address">{data.explorerUrl?<a href={data.explorerUrl} target="_blank" rel="noreferrer">{short(data.address)} ↗</a>:short(data.address)}</div>}
    </header>
    {error && <div role="status" className="account-error">Account updates are unavailable. <Button size="sm" variant="ghost" onClick={()=>void refresh()}>Try again</Button></div>}
    <section aria-labelledby="holdings-heading"><h2 id="holdings-heading">Holdings</h2>
      {!data?<div className="account-skeleton account-table-skeleton"/>:held.length ? <div className="account-table-scroll" tabIndex={0} aria-label="GPU holdings"><table className="account-table"><thead><tr>{["GPU","Shares","Locked","Value","24h","Yield","Earned 7d"].map(t=><th key={t} scope="col">{t}</th>)}</tr></thead><tbody>{held.map(h=><tr key={h.gpuId}>
        <td><Link className="account-gpu" href={`/gpu/${h.gpuId}`}><DataMoon slots={h.slots??[]} size={28}/><span>{h.label}<small>{h.hardware}</small></span></Link></td>
        <td>{money(h.shares)}</td><td>{money(h.locked)}</td><td><Link href={`/gpu/${h.gpuId}`}><PriceFlash value={Number(h.value)} decimals={2}/><small>USDC</small></Link></td>
        <td>{h.change24h===null?<span aria-label="Price history unavailable">·</span>:<span style={{color:Number(h.change24h)>0?"var(--up)":Number(h.change24h)<0?"var(--down)":"var(--ink2)"}}>{Number(h.change24h)>0?"+":""}<PriceFlash value={Number(h.change24h)} decimals={2}/>%</span>}</td>
        <td>{money(h.yield)}%</td><td className="account-income">+{money(h.earned7d)}</td>
      </tr>)}</tbody></table></div>:<div className="account-empty"><span>No GPU shares yet</span><Button href="/market" size="sm">Browse GPUs</Button></div>}
    </section>
    <PortfolioReturns/>
    <GpuMarketPrices/>
    <section aria-labelledby="earnings-heading"><div className="account-section-head"><h2 id="earnings-heading">GPU revenue</h2>{!!options.length && <Segmented options={options} value={selected} onChange={setSelection}/>}</div>
      {!deferred?<div className="account-skeleton account-chart-skeleton"/>:!held.length?<p className="account-muted">No GPU earnings yet</p>:<div className="account-earnings" ref={chart}>
        <div className="account-chart"><div className="account-chart-legend"><span><i/>Booked</span><span><i/>Inference</span></div>
          <svg viewBox="0 0 700 245" role="img" aria-label="GPU revenue over seven days" className={inView?"account-bars-visible":""}>
            <line x1="12" y1="207" x2="688" y2="207" stroke="var(--rule)"/>
            {days.map((d,i)=>{const x=30+i*96,booked=d.booked/max*170,inference=d.inference/max*170;return <g key={d.date} tabIndex={0} role="graphics-symbol" aria-label={`${date(d.date+"T12:00:00Z")} Booked ${money(d.booked)} Inference ${money(d.inference)} USDC`} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)}>
              <rect x={x-8} y="12" width="72" height="198" fill="transparent"/>
              <g className="account-bar"><rect x={x} y={207-booked} width="48" height={booked} fill="var(--ink)"/><rect x={x} y={207-booked-inference} width="48" height={inference} fill="var(--accent)"/></g>
              <text x={x+24} y="235" textAnchor="middle" fill="var(--ink3)" fontSize="13">{new Intl.DateTimeFormat("en-US",{weekday:"short",timeZone:"UTC"}).format(new Date(d.date+"T12:00:00Z"))}</text>
            </g>;})}
          </svg>
          <div className="account-tooltip" role="status">{hover!==null && days[hover] ? `${new Intl.DateTimeFormat("en-US",{weekday:"short",day:"numeric",timeZone:"UTC"}).format(new Date(days[hover].date+"T12:00:00Z"))} · Booked ${money(days[hover].booked)} · Inference ${money(days[hover].inference)} USDC`:"\u00a0"}</div>
        </div>
        <dl className="account-stats"><div><dt>Revenue 24h</dt><dd>{money(revenue)} <span>USDC</span></dd></div><div><dt>Utilization 24h</dt><dd>{money(utilization)}%</dd></div><div><dt>Your share</dt><dd>{money(ownership*100)}% <span>· <span className="account-income">+{money(earned)} USDC</span></span></dd></div></dl>
      </div>}
    </section>
    <section aria-labelledby="loans-heading"><h2 id="loans-heading">Loans</h2>
      {!data?<div className="account-skeleton account-chart-skeleton"/>:!data.loans.length?<div className="account-empty"><span>No open loans</span><Button variant="ghost" href="/borrow" size="sm">Borrow</Button></div>:<div className="account-loans">{data.loans.map(l=><article key={l.id} className="account-loan">
        <div className="account-loan-top"><div><h3>Loan {short(l.id)}</h3><p className="account-loan-number">{money(l.outstanding)} <span>USDC</span></p><p className="account-muted">Next payment {money(l.nextPayment.amount)} USDC{l.nextPayment.dueAt?` · ${date(l.nextPayment.dueAt)}`:""}</p></div>
        <div className="account-margin"><p>Price can fall <strong>{Math.max(0,Number(l.priceDropToMarginCall)*100).toFixed(0)}%</strong> before a margin call</p><span className={l.status==="margin call"?"account-danger":""}>{l.status==="margin call"?"Margin call":l.status==="watch"?"Watch":"Healthy"}</span></div></div>
        <HealthMeter ltv={Number(l.ltv)} marginCallLtv={Number(l.marginCallLtv)} liquidationLtv={Number(l.liquidationLtv)}/>
        <div className="account-actions"><Button size="sm" disabled={!!busy} onClick={()=>void repay(l.id)}>{busy===l.id?"Repaying…":"Repay"}</Button>{l.explorerUrl && <Button variant="ghost" size="sm" href={l.explorerUrl}>View on ledger</Button>}</div>
      </article>)}</div>}
    </section>
    <section aria-labelledby="activity-heading"><h2 id="activity-heading">Activity</h2>
      {!deferred?<div className="account-skeleton account-chart-skeleton"/>:!data?.activity.length?<p className="account-muted">No activity yet</p>:<><ol className="account-activity">{data.activity.slice(0,visible).map(a=><li key={a.id}>
        <time dateTime={a.time}>{date(a.time)}, {new Intl.DateTimeFormat("en-US",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"America/New_York"}).format(new Date(a.time))}</time><span>{a.type}</span>
        <span className={`account-amount ${a.direction==="in" && a.unit==="USDC"?"account-income":""}`}>{a.amount!==null?`${a.direction==="in"?"+":a.direction==="out"?"−":""}${money(a.amount)} ${a.unit}`:""}</span>
        <span className="account-hash">{a.txHash && (a.explorerUrl?<a href={a.explorerUrl} target="_blank" rel="noreferrer">{short(a.txHash)} ↗</a>:short(a.txHash))}</span>
      </li>)}</ol>{visible<data.activity.length && <Button variant="ghost" size="sm" onClick={()=>setVisible(v=>v+15)}>Show more</Button>}</>}
    </section>
  </main>;
}

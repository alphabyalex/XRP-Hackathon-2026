import { Router } from "express";
import { GPUS, fix6, networkInfo, type AccountResponse, type AccountActivity } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as lending from "../adapters/lendingAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import * as svc from "../lending/service.js";
import { db } from "../db/db.js";
import { buildReturns } from "../marketData/returns.js";
import { change24hPct, sharePrice } from "../sharePrice.js";
import { historyCalendar } from "../marketHistory.js";

import { asActor } from "../middleware/session.js";
export const accountRouter = Router();
accountRouter.get("/account/:account/returns", asActor("params", "account"), (req, res) => {
  const days = Number(req.query.days ?? 30);
  if (![7, 30, 90].includes(days)) {
    res.status(400).json({ error: { code: "BAD_RANGE", message: "Choose 7, 30 or 90 days" } }); return;
  }
  try {
    const name = svc.asAccountName(req.params.account);
    const address = lending.addressOf(name);
    const receipts = db.prepare(`SELECT r.gpu_id AS gpuId, p.amount, COALESCE(t.created_at, r.created_at) AS time
      FROM payouts p JOIN dividend_runs r ON p.dividend_run_id=r.id
      LEFT JOIN tx_log t ON t.hash=p.tx_hash
      WHERE (p.account=? OR p.account=?) AND p.tx_hash IS NOT NULL AND COALESCE(t.created_at, r.created_at)>=?`)
      .all(name, address, new Date(Date.now() - 91 * 86400000).toISOString()) as { gpuId: string; amount: string; time: string }[];
    res.json(buildReturns(name, days, receipts));
  } catch {
    res.status(502).json({ error: { code: "RETURNS_UNAVAILABLE", message: "Returns are temporarily unavailable" } });
  }
});
const cache = new Map<string, { expires: number; value: AccountResponse }>();
const pending = new Map<string, Promise<AccountResponse>>();
let revision = 0;
// A write elsewhere in the application must invalidate these read snapshots.
import { onAccountEvent } from "../sse.js";
onAccountEvent(() => { revision++; cache.clear(); });
const n = (v: unknown) => Number(v ?? 0);
const rows = (sql: string, ...args: string[]): any[] => db.prepare(sql).all(...args) as any[];

export async function buildAccount(input: string): Promise<AccountResponse> {
  const account = svc.asAccountName(input);
  const address = lending.addressOf(account);
  const aliases = [account, address];
  const now = Date.now();
  const since = (days: number) => new Date(now - days * 86400000).toISOString();
  const [balances, records, gpuData] = await Promise.all([
    xrpl.getBalances(account), svc.listLoans(account),
    Promise.all(GPUS.map(async gpu => {
      const [nav, oracle, history, calendar] = await Promise.all([
        pricing.getNav(gpu.id), sharePrice(gpu.id), compute.getRevenueHistory(gpu.id, 168),
        compute.getCalendar(gpu.id, since(1), new Date(now).toISOString()),
      ]);
      // One activity state, from the same merged schedule the GPU page draws.
      const merged = [...calendar, ...historyCalendar(gpu.id, since(1), new Date(now).toISOString())];
      const slots = Array.from({length:288}, (_,i): "b"|"l"|"i"|"o" => {
        const at = now-86400000+i*300000;
        return merged.some(e => Date.parse(e.start)<=at && Date.parse(e.end)>at) ? "l" : "i";
      });
      return { gpu, nav, oracle, history, slots };
    })),
  ]);
  const explorer = lending.MOCK ? null : networkInfo().explorer;
  const txUrl = (hash: string | null) => hash && !hash.startsWith("MOCK") && explorer ? `${explorer}/transactions/${hash}` : null;
  const payouts = rows(`SELECT p.*, r.gpu_id, r.created_at FROM payouts p JOIN dividend_runs r ON r.id=p.dividend_run_id WHERE (p.account=? OR p.account=?) AND p.tx_hash IS NOT NULL`, ...aliases);
  const earned = (days: number, gpuId?: string) => payouts.filter(p => p.created_at >= since(days) && (!gpuId || p.gpu_id === gpuId)).reduce((sum, p) => sum + n(p.amount), 0);
  const open = records.filter(l => l.status === "open" || l.status === "margin_call");
  const holdings = gpuData.map(({gpu, nav, oracle, slots}) => {
    const free = n(balances.tokens[gpu.shareCode]);
    const locked = open.filter(l => l.gpuId === gpu.id && l.ledger?.collateral?.locked).reduce((s,l) => s + n(l.collateralShares),0);
    const shares = free + locked;
    return { gpuId: gpu.id, label: gpu.label, hardware: gpu.hw.replace(/\s*\(simulated[^)]*\)/gi, ""), slots, free: fix6(free), locked: fix6(locked), shares: fix6(shares), sharePrice: oracle.price, value: fix6(shares * n(oracle.price)), change24h: change24hPct(gpu.id, oracle.price), yield: nav.implied_yield_pct, earned7d: fix6(earned(7,gpu.id)), ownershipPct: fix6(shares/1000) };
  }).filter(h => n(h.shares)>0);
  const gpuPerformance = gpuData.filter(d => holdings.some(h => h.gpuId===d.gpu.id)).map(({gpu, history}) => {
    const dayMap = new Map<string, {booked:number; inference:number; active:number; minutes:number}>();
    // Compute's revenue contract prices booked minutes at 4.95/hour and inference at 1.80/hour.
    // Allocate the returned revenue by those weights, preserving its total exactly.
    const split = (b: typeof history.buckets[number]) => {
      const bookedWeight=b.bookedMinutes*4.95, inferenceWeight=b.inferenceMinutes*1.8;
      const total=bookedWeight+inferenceWeight;
      return total ? n(b.revenue)*bookedWeight/total : 0;
    };
    for (const b of history.buckets) {
      const date=b.start.slice(0,10), d=dayMap.get(date) ?? {booked:0,inference:0,active:0,minutes:0};
      const minutes=(Date.parse(b.end)-Date.parse(b.start))/60000;
      const booked=split(b); d.booked+=booked; d.inference+=n(b.revenue)-booked; d.active+=n(b.utilizationPct)*minutes; d.minutes+=minutes; dayMap.set(date,d);
    }
    const last=history.buckets.slice(-24);
    return { gpuId:gpu.id, days:[...dayMap].slice(-7).map(([date,d])=>({date,booked:fix6(d.booked),inference:fix6(d.inference),utilization:fix6(d.minutes ? d.active/d.minutes : 0)})), revenue24h:fix6(last.reduce((s,b)=>s+n(b.revenue),0)), utilization24h:fix6(last.length ? last.reduce((s,b)=>s+n(b.utilizationPct),0)/last.length : 0) };
  });
  const loans = open.map(l => {
    if (!l.ledger || !l.health) throw new Error("Loan ledger is unavailable");
    const ltv=n(l.health.ltv), margin=n(l.marginCallLtv);
    return {id:l.id,gpuId:l.gpuId,outstanding:l.ledger.totalValueOutstanding,collateralShares:l.collateralShares,collateralValue:l.health.collateralValue,ltv:l.health.ltv,marginCallLtv:l.marginCallLtv,liquidationLtv:l.liquidationLtv,priceDropToMarginCall:fix6(1-ltv/margin),nextPayment:{amount:l.ledger.periodicPayment,dueAt:l.ledger.nextPaymentDueDate},status:(l.status==="margin_call" || ltv>=margin ? "margin call" : ltv>=margin*0.8 ? "watch" : "healthy") as "healthy"|"watch"|"margin call",txs:l.txs,explorerUrl:l.ledger.explorerUrl?.startsWith("https://") ? l.ledger.explorerUrl : txUrl(l.txs.loanSet)};
  });
  const activity: AccountActivity[] = payouts.map(p=>({id:p.id,time:p.created_at,type:"Dividend",amount:p.amount,unit:"USDC",direction:"in",txHash:p.tx_hash,explorerUrl:txUrl(p.tx_hash)}));
  const types: Record<string,[string,"in"|"out"|"neutral",string]>={buyShares:["Bought shares","out","shares"],sellShares:["Sold shares","in","shares"],buyContracts:["Booked time","out","slots"],redeemContracts:["Booking","neutral","slots"],"loan.open":["Loan opened","in","USDC"],"loan.pay":["Payment","out","USDC"],"loan.margin_call":["Margin call","neutral","USDC"],"loan.liquidate":["Liquidation","neutral","shares"],"loan.release":["Collateral released","neutral","shares"]};
  for (const r of rows(`SELECT * FROM tx_log WHERE account=? OR account=? ORDER BY created_at DESC LIMIT 50`,...aliases)) {
    const spec=types[r.kind]; if (!spec || activity.some(a=>a.txHash===r.hash)) continue;
    const loan=records.find(l=>Object.values(l.txs).includes(r.hash));
    const qty=/\b(?:bought|sold|borrowed)\s+([\d.]+)/i.exec(r.summary)?.[1];
    const amount=r.kind==="loan.open" ? loan?.principal ?? qty ?? null : r.kind==="loan.release" || r.kind==="loan.liquidate" ? loan?.collateralShares ?? null : qty ?? null;
    activity.push({id:r.hash,time:r.created_at,type:spec[0],direction:spec[1],amount,unit:spec[2],txHash:r.hash,explorerUrl:txUrl(r.hash)});
  }
  return {account,address,explorerUrl:explorer ? `${explorer}/accounts/${address}` : null,updatedAt:new Date().toISOString(),balances:{usdc:balances.tokens.TDX ?? "0.000000",xrp:balances.xrp,shares:holdings.map(h=>({gpuId:h.gpuId,free:h.free,locked:h.locked}))},holdings,gpuPerformance,loans,activity:activity.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,50),totals:{totalValue:fix6(n(balances.tokens.TDX)+holdings.reduce((s,h)=>s+n(h.value),0)-loans.reduce((s,l)=>s+n(l.outstanding),0)),earned7d:fix6(earned(7)),earned30d:fix6(earned(30))}};
}
accountRouter.get("/account/:account", asActor("params", "account"), async (req,res) => {
  try {
    const key=req.params.account;
    if (!/^(?:[A-Z_]{2,32}|U_r[1-9A-HJ-NP-Za-km-z]{24,34}|r[1-9A-HJ-NP-Za-km-z]{24,34})$/.test(key)) { res.status(400).json({error:{code:"BAD_ACCOUNT",message:"Invalid account"}}); return; }
    const cached=cache.get(key);
    if(cached && cached.expires>Date.now()) {res.json(cached.value);return;}
    const startedAtRevision=revision;
    let work=pending.get(key);
    if(!work) {work=buildAccount(key);pending.set(key,work);}
    const value=await work;
    if(startedAtRevision===revision) cache.set(key,{expires:Date.now()+15000,value});
    res.json(value);
  } catch(e) {res.status(502).json({error:{code:"ACCOUNT_UNAVAILABLE",message:"Account data is temporarily unavailable"}});}
  finally {pending.delete(req.params.account);}
});

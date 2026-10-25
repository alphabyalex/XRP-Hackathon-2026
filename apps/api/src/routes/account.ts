import { Router } from "express";
import { GPUS, fix6, networkInfo, type AccountResponse, type AccountActivity } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as lending from "../adapters/lendingAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as svc from "../lending/service.js";
import { payoutYield } from "../gpuStats.js";
import { db } from "../db/db.js";
import { buildReturns } from "../marketData/returns.js";
import { change24hPct, sharePrice } from "../sharePrice.js";
import { historyCalendar } from "../marketHistory.js";
import { verifiedGpuSpec } from "../marketData/rentalCatalog.js";
import { holdingPerformance, ownedGpuIds, readHoldingTelemetry } from "../accountTelemetry.js";

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
  const [balances, records] = await Promise.all([xrpl.getBalances(account), svc.listLoans(account)]);
  const open = records.filter(l => l.status === "open" || l.status === "margin_call");
  // Financial ownership comes from balances and locked collateral, even when a
  // worker is offline. Unowned workers cannot hold the account page hostage.
  const owned = new Set(ownedGpuIds(GPUS, balances.tokens, records));
  const ownedGpus = GPUS.filter(gpu => owned.has(gpu.id));
  const telemetry = await readHoldingTelemetry(ownedGpus.map(gpu => gpu.id), {
    calendar: gpuId => compute.getCalendar(gpuId as (typeof GPUS)[number]["id"], since(1), new Date(now).toISOString()),
    revenue: gpuId => compute.getRevenueHistory(gpuId as (typeof GPUS)[number]["id"], 168),
  });
  const gpuData = await Promise.all(ownedGpus.map(async gpu => {
    const observed = telemetry.find(row => row.gpuId === gpu.id)!;
    const oracle = await sharePrice(gpu.id).catch(() => null);
    const merged = observed.calendar === null ? null : [...observed.calendar, ...historyCalendar(gpu.id, since(1), new Date(now).toISOString())];
    const slots = merged === null ? undefined : Array.from({ length: 288 }, (_, i): "b" | "l" | "i" | "o" => {
      const at = now - 86400000 + i * 300000;
      return merged.some(e => Date.parse(e.start) <= at && Date.parse(e.end) > at) ? "l" : "i";
    });
    return { gpu, oracle, slots, calendar: merged, history: observed.history, calendarAvailable: observed.calendar !== null };
  }));
  const explorer = lending.MOCK ? null : networkInfo().explorer;
  const txUrl = (hash: string | null) => hash && !hash.startsWith("MOCK") && explorer ? `${explorer}/transactions/${hash}` : null;
  const payouts = rows(`SELECT p.*, r.gpu_id, r.created_at FROM payouts p JOIN dividend_runs r ON r.id=p.dividend_run_id WHERE (p.account=? OR p.account=?) AND p.tx_hash IS NOT NULL`, ...aliases);
  const earned = (days: number, gpuId?: string) => payouts.filter(p => p.created_at >= since(days) && (!gpuId || p.gpu_id === gpuId)).reduce((sum, p) => sum + n(p.amount), 0);
  const holdings = gpuData.map(({gpu, oracle, slots, history, calendarAvailable}) => {
    const physical = verifiedGpuSpec(gpu.id);
    const free = n(balances.tokens[gpu.shareCode]);
    const locked = open.filter(l => l.gpuId === gpu.id && l.ledger?.collateral?.locked).reduce((s,l) => s + n(l.collateralShares),0);
    const shares = free + locked;
    return { gpuId: gpu.id, label: gpu.label, hardware: physical ? `${physical.card} ${physical.vramGb}GB` : "Hardware verification pending", slots, free: fix6(free), locked: fix6(locked), shares: fix6(shares), sharePrice: oracle?.price ?? null, value: oracle ? fix6(shares * n(oracle.price)) : null, change24h: oracle ? change24hPct(gpu.id, oracle.price) : null, yield: oracle ? payoutYield(gpu.id, oracle.price).yieldPct : null, earned7d: fix6(earned(7,gpu.id)), ownershipPct: fix6(shares/1000), telemetry: { calendarAvailable, revenueAvailable: (history?.buckets.length ?? 0) > 0 } };
  }).filter(h => n(h.shares)>0);
  const gpuPerformance = gpuData.map(({gpu, history, calendar}) => holdingPerformance(gpu.id, history, now, calendar));
  const loans = open.map(l => {
    if (!l.ledger || !l.health) throw new Error("Loan ledger is unavailable");
    const ltv=n(l.health.ltv), margin=n(l.marginCallLtv);
    return {id:l.id,gpuId:l.gpuId,outstanding:l.ledger.totalValueOutstanding,collateralShares:l.collateralShares,collateralValue:l.health.collateralValue,ltv:l.health.ltv,marginCallLtv:l.marginCallLtv,liquidationLtv:l.liquidationLtv,priceDropToMarginCall:fix6(1-ltv/margin),nextPayment:{amount:l.ledger.periodicPayment,dueAt:l.ledger.nextPaymentDueDate},status:(l.status==="margin_call" || ltv>=margin ? "margin call" : ltv>=margin*0.8 ? "watch" : "healthy") as "healthy"|"watch"|"margin call",txs:l.txs,explorerUrl:l.ledger.explorerUrl?.startsWith("https://") ? l.ledger.explorerUrl : txUrl(l.txs.loanSet)};
  });
  const activity: AccountActivity[] = payouts.map(p=>({id:p.id,time:p.created_at,type:"Dividend",amount:p.amount,unit:"USDC",direction:"in",txHash:p.tx_hash,explorerUrl:txUrl(p.tx_hash)}));
  const types: Record<string,[string,"in"|"out"|"neutral",string]>={buyShares:["Bought shares","out","shares"],sellShares:["Sold shares","in","shares"],buyContracts:["Compute bought","out","slots"],redeemContracts:["Compute used","neutral","slots"],"loan.open":["Loan opened","in","USDC"],"loan.pay":["Payment","out","USDC"],"loan.margin_call":["Margin call","neutral","USDC"],"loan.liquidate":["Liquidation","neutral","shares"],"loan.release":["Shares returned","neutral","shares"]};
  for (const r of rows(`SELECT * FROM tx_log WHERE account=? OR account=? ORDER BY created_at DESC LIMIT 50`,...aliases)) {
    const spec=types[r.kind]; if (!spec || activity.some(a=>a.txHash===r.hash)) continue;
    const loan=records.find(l=>Object.values(l.txs).includes(r.hash));
    const qty=/\b(?:bought|sold|borrowed)\s+([\d.]+)/i.exec(r.summary)?.[1];
    const amount=r.kind==="loan.open" ? loan?.principal ?? qty ?? null : r.kind==="loan.release" || r.kind==="loan.liquidate" ? loan?.collateralShares ?? null : qty ?? null;
    activity.push({id:r.hash,time:r.created_at,type:spec[0],direction:spec[1],amount,unit:spec[2],txHash:r.hash,explorerUrl:txUrl(r.hash)});
  }
  return {account,address,explorerUrl:explorer ? `${explorer}/accounts/${address}` : null,updatedAt:new Date().toISOString(),balances:{usdc:balances.tokens.TDX ?? "0.000000",xrp:balances.xrp,shares:holdings.map(h=>({gpuId:h.gpuId,free:h.free,locked:h.locked}))},holdings,gpuPerformance,loans,activity:activity.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,50),totals:{totalValue:holdings.some(h=>h.value===null) ? null : fix6(n(balances.tokens.TDX)+holdings.reduce((s,h)=>s+n(h.value),0)-loans.reduce((s,l)=>s+n(l.outstanding),0)),earned7d:fix6(earned(7)),earned30d:fix6(earned(30))}};
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

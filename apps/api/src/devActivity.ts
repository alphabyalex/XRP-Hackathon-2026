// Small real devnet trades from DEV. No user account is ever a bot actor.
import { randomUUID } from 'node:crypto';
import { getAccountAddress } from '@moonshift/xrpl';
import { networkName, fix6 } from '@moonshift/shared';
import * as xrpl from './adapters/xrplAdapter.js';
import { listedGpus } from './gpuHealth.js';
import { recordTrade } from './sharePrice.js';
import { logTx } from './db/helpers.js';
import { db } from './db/db.js';
import { broadcast } from './sse.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
db.exec(`CREATE TABLE IF NOT EXISTS dev_activity_intents (id TEXT PRIMARY KEY, gpu_id TEXT NOT NULL, status TEXT NOT NULL, hash TEXT, created_at TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS dev_activity_trades (hash TEXT PRIMARY KEY, gpu_id TEXT NOT NULL, side TEXT NOT NULL, notional REAL NOT NULL, created_at TEXT NOT NULL)`);

export async function devActivityTick() {
  if (running || process.env.MOCK_XRPL !== '0' || networkName() !== 'devnet' || process.env.DEV_ACTIVITY === '0') return;
  running=true;
  try {
    // An interrupted ledger submission must be reconciled before another bot trade.
    if (db.prepare("SELECT 1 FROM dev_activity_intents WHERE status IN ('pending','uncertain') LIMIT 1").get()) return;
    const spent=db.prepare("SELECT COALESCE(SUM(notional),0) AS total,COUNT(*) AS n FROM dev_activity_trades WHERE created_at >= ?").get(new Date().toISOString().slice(0,10)) as {total:number;n:number};
    // Limit gross daily turnover as well as each transaction. This is devnet USDC.
    if(spent.total>=120) return;
    const gpus=listedGpus();
    const gpu=gpus[spent.n % gpus.length];
    if(!gpu) return;
    const [balances,book]=await Promise.all([xrpl.getBalances('DEV'),xrpl.getShareBook(gpu.id)]);
    const inventory=Number(balances.tokens[gpu.shareCode]??0),cash=Number(balances.tokens.TDX??0);
    const sell=Math.floor(spent.n / gpus.length)%2===1 && inventory>=0.2;
    const px=Number(sell?book.bestBid:book.bestAsk);
    if(!(px>0)) return;
    const qty=Math.min(0.05+(spent.n%4)*0.025, 2/px, sell?inventory:Math.max(0,cash-5)/px, (120-spent.total)/px);
    if(qty<0.000001) return;
    const intent = randomUUID();
    db.prepare("INSERT INTO dev_activity_intents (id,gpu_id,status,created_at) VALUES (?,?,'pending',?)").run(intent,gpu.id,new Date().toISOString());
    let tx;
    try {
      tx = sell
        ? await xrpl.sellShares({seller:'DEV',gpuId:gpu.id,qty:fix6(qty),pricePerShare:fix6(px)}, true)
        : await xrpl.buyShares({buyer:'DEV',gpuId:gpu.id,qty:fix6(qty),maxPricePerShare:fix6(px)});
    } catch (error) {
      db.prepare("UPDATE dev_activity_intents SET status='uncertain' WHERE id=?").run(intent);
      throw error;
    }
    if (!tx.validated) { db.prepare("UPDATE dev_activity_intents SET status='uncertain',hash=? WHERE id=?").run(tx.hash,intent); return; }
    if (tx.result !== 'tesSUCCESS') { db.prepare("UPDATE dev_activity_intents SET status='rejected',hash=? WHERE id=?").run(tx.hash,intent); return; }
    const fill=await xrpl.shareFill(tx.hash,getAccountAddress('DEV'),gpu.id);
    if(!fill) {
      // Both sides are IOC, so a validated no-fill transaction leaves no live order.
      db.prepare("UPDATE dev_activity_intents SET status='unfilled',hash=? WHERE id=?").run(tx.hash,intent);
      return;
    }
    await recordTrade(gpu.id,tx.hash,getAccountAddress('DEV'));
    const at=new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO dev_activity_trades VALUES (?,?,?,?,?)').run(tx.hash,gpu.id,fill.side,Number(fill.price)*Number(fill.qty),at);
    db.prepare("UPDATE dev_activity_intents SET status='confirmed',hash=? WHERE id=?").run(tx.hash,intent);
    logTx(tx,'market.activity','DEV',`DEV ${fill.side==='buy'?'bought':'sold'} ${fill.qty} ${gpu.label} shares`);
    broadcast('market',{gpuId:gpu.id,hash:tx.hash,side:fill.side,price:fill.price,qty:fill.qty,updatedAt:at,source:'ledger'});
  } finally {running=false;}
}
export function startDevActivity() {
  if(timer || process.env.DEV_ACTIVITY==='0' || process.env.MOCK_XRPL!=='0' || networkName()!=='devnet') return;
  timer=setInterval(()=>{void devActivityTick().catch(()=>{});},45000);
}
export function stopDevActivity(){if(timer)clearInterval(timer);timer=null;}
export function isDevActivityRunning(){return timer!==null;}

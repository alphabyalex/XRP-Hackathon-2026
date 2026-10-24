import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
let playwright;
try { playwright = await import('playwright'); }
catch {
  const fallback = process.env.PLAYWRIGHT_MODULE;
  if (!fallback) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to its index.mjs');
  playwright = await import(pathToFileURL(path.resolve(fallback)).href);
}
const base = process.env.WEB_URL || 'http://localhost:3000';
const api = process.env.API_URL || 'http://localhost:4000';
const browser = await playwright.chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
const errors = [];
const results = [];
const output = path.resolve('docs/screens');
await mkdir(output, {recursive:true});
try {
  // Warm the route as a production server would be before timing navigation.
  const warm = await fetch(`${base}/portfolio`); assert.equal(warm.status,200);
  const account = await (await fetch(`${api}/account/ALICE`)).json();
  assert.ok(account.totals, 'Account snapshot is available');
  await writeFile('contracts/api/account.json', JSON.stringify(account,null,2)+'\n');
  const started = performance.now();
  const cached = await fetch(`${api}/account/ALICE`); assert.equal(cached.status,200);
  const elapsed = performance.now()-started;
  assert.ok(elapsed<500, `Warm account request ${elapsed.toFixed(0)}ms`);
  results.push(`PASS warm /account/ALICE ${elapsed.toFixed(0)}ms (<500ms)`);
  for(const width of [1280,400]) {
    const page = await browser.newPage({viewport:{width,height:1000}});
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    page.on('pageerror',error=>errors.push(error.message));
    const start=performance.now();
    await page.goto(`${base}/portfolio`,{waitUntil:'domcontentloaded'});
    await page.getByTestId('net-worth').waitFor({timeout:2000});
    const time=performance.now()-start;
    assert.ok(time<2000, `Net worth at ${width}px took ${time.toFixed(0)}ms`);
    await page.getByRole('heading',{name:'Activity',exact:true}).scrollIntoViewIfNeeded();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
    const text=await page.locator('body').innerText();
    assert.equal(/\b(demo|simulated|mock|test|devnet|mainnet|testnet)\b/i.test(text),false,'Production copy');
    assert.equal(text.includes('—'),false,'No em dashes');
    const nav=await page.locator('nav[aria-label="Main"] a').allTextContents();
    assert.deepEqual(nav,['Borrow','Lend','Market','Portfolio','Developers','How it earns']);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.addStyleTag({content:'nextjs-portal { display:none }'});
    await page.screenshot({path:path.join(output,`portfolio-${width}.png`),fullPage:true});
    results.push(`PASS ${width}px: net worth ${time.toFixed(0)}ms, no horizontal scroll, production copy, nav order, screenshot saved`);
    await page.close();
  }
  // Read fixtures exercise populated states without changing ledger data.
  const fixture = structuredClone(account);
  fixture.address = 'rPScK1uuXC9szrSg2qqkzMYqXGvK6Q2hYT';
  fixture.explorerUrl = 'https://devnet.xrpl.org/accounts/'+fixture.address;
  fixture.holdings = ['gpu-a','gpu-b'].map((gpuId,i)=>({gpuId,label:`GPU-${i?'B':'A'}`,hardware:'NVIDIA RTX 4090',free:'100',locked:i?'0':'50',shares:i?'100':'150',sharePrice:'5.25',value:i?'525':'787.5',change24h:i?'-1.4':'2.1',yield:'12.4',earned7d:i?'7.2':'11.22',ownershipPct:i?'0.1':'0.15'}));
  fixture.gpuPerformance = fixture.holdings.map((h,i)=>({gpuId:h.gpuId,revenue24h:'48.2',utilization24h:'72',days:Array.from({length:7},(_,day)=>({date:`2026-10-${18+day}`,booked:String(20+day*2+i),inference:String(10+day+i),utilization:'72'}))}));
  fixture.loans=[{id:'658A123456789EDD5',gpuId:'gpu-a',outstanding:'233',collateralShares:'100',collateralValue:'706',ltv:'0.33',marginCallLtv:'0.49',liquidationLtv:'0.64',priceDropToMarginCall:'0.32653',nextPayment:{amount:'8.12',dueAt:'2026-10-26T16:00:00Z'},status:'healthy',txs:{loanSet:'A'.repeat(64)},explorerUrl:'https://devnet.xrpl.org/transactions/'+'A'.repeat(64)}];
  fixture.activity=Array.from({length:20},(_,i)=>({id:String(i),time:'2026-10-24T18:05:00Z',type:'Dividend',amount:'1.25',unit:'USDC',direction:'in',txHash:String(i).padStart(64,'A'),explorerUrl:'https://devnet.xrpl.org/transactions/'+String(i).padStart(64,'A')}));
  for (const width of [1280,400]) {
    const page=await browser.newPage({viewport:{width,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    let reads=0,repayments=0;
    await page.route('**/account/ALICE',route=>{reads++;return route.fulfill({json:fixture});});
    await page.route('**/loans/*/repay',route=>{repayments++;return route.fulfill({json:{txs:{pay:'B'.repeat(64)}}});});
    await page.goto(`${base}/portfolio`);
    await page.getByTestId('net-worth').waitFor();
    assert.equal(await page.locator('.account-table tbody tr').count(),2);
    await page.getByRole('button',{name:'GPU-B',exact:true}).click();
    await page.locator('.account-chart').scrollIntoViewIfNeeded();
    await page.locator('.account-bars-visible').waitFor();
    assert.equal(await page.locator('.account-chart svg g[role="graphics-symbol"]').count(),7);
    await page.locator('.account-chart svg g[role="graphics-symbol"]').first().focus();
    await page.getByRole('status').filter({hasText:'Booked'}).waitFor();
    await page.getByRole('button',{name:'All',exact:true}).click();
    assert.equal(await page.locator('.account-activity li').count(),15);
    await page.getByRole('button',{name:'Show more',exact:true}).click();
    assert.equal(await page.locator('.account-activity li').count(),20);
    await page.getByRole('button',{name:'Repay',exact:true}).click();
    await page.locator('.toast.on').filter({hasText:'Loan repaid'}).waitFor();
    assert.equal(repayments,1); assert.ok(reads>=2,'Repayment refreshes account');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Populated overflow at ${width}`);
    assert.equal(/\b(demo|simulated|mock|test|devnet|mainnet|testnet)\b/i.test(await page.locator('body').innerText()),false);
    if(width===400) { await page.addStyleTag({content:'nextjs-portal {display:none}'}); await page.screenshot({path:path.join(process.env.TEMP || '/tmp','portfolio-populated.png'),fullPage:true}); }
    results.push(`PASS populated ${width}px: holdings, seven bars, GPU selection, tooltip, pagination, repayment route and refresh, no overflow`);
    await page.close();
  }
  assert.deepEqual(errors,[], 'No browser console or page errors');
  results.push('PASS no console errors');
  console.log(results.join('\n'));
} finally { await browser.close(); }


import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityLadder, confirmedLiquidityUpdates } from './liquidity.js';
test('five real-funded levels remain ordered and fit inventory/cash budgets',()=>{
 const {asks,bids}=liquidityLadder(20,300,1000);
 assert.equal(asks.length,5);assert.equal(bids.length,5);
 assert(asks.every((x,i)=>Number(x.price)>20 && (!i || Number(x.price)>Number(asks[i-1].price))));
 assert(bids.every((x,i)=>Number(x.price)<20 && (!i || Number(x.price)<Number(bids[i-1].price))));
 assert(asks.reduce((a,l)=>a+Number(l.qty),0)<=200);
 assert(bids.reduce((a,l)=>a+Number(l.qty)*Number(l.price),0)<=800);
 assert(Number(asks[0].price)>Number(bids[0].price));
});
test('no cash or inventory creates no invented liquidity',()=>{
 assert.deepEqual(liquidityLadder(20,0,0),{asks:[],bids:[]});
 const tiny=liquidityLadder(5,0.1,0.2);assert(tiny.asks.reduce((a,l)=>a+Number(l.qty),0)<=0.08+1e-9);assert(tiny.bids.reduce((a,l)=>a+Number(l.qty)*Number(l.price),0)<=0.16+1e-9);
 for(const x of [NaN,Infinity,-1,0])assert.throws(()=>liquidityLadder(x,100,100));
});

test('a claimed-fee cancellation failure never places replacement offers or claims success', async()=>{
 let creates=0;
 await assert.rejects(confirmedLiquidityUpdates([async()=>({hash:'cancel',validated:true,result:'tecNO_PERMISSION'})],[async()=>{creates++;return {hash:'create',validated:true,result:'tesSUCCESS'};}]));
 assert.equal(creates,0);
 await assert.rejects(confirmedLiquidityUpdates([],[async()=>({hash:'pending',validated:false,result:'tesSUCCESS'})]));
 assert.deepEqual(await confirmedLiquidityUpdates([async()=>({hash:'c',validated:true,result:'tesSUCCESS'})],[async()=>({hash:'p',validated:true,result:'tesSUCCESS'})]),['c','p']);
});

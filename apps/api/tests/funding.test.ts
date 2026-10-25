import test from 'node:test';
import assert from 'node:assert/strict';
import { promptFunding, assertFunded } from '../src/middleware/funding.js';
import type { Request, Response } from 'express';

async function attempt(user:boolean,balance:string|Error, buyer='DEV') {
 let status=200,body:any,admitted=false,reads=0;
 const req={body:{buyer,balance:'1000000000'},headers:{},header:()=>undefined,...(user?{user:{name:'U_realAccount'}}:{})} as unknown as Request;
 const res={status:(n:number)=>{status=n;return res;},json:(b:any)=>{body=b;return res;}} as unknown as Response;
 await promptFunding(async(account)=>{reads++;assert.equal(account,'U_realAccount');if(balance instanceof Error)throw balance;return {balance,balanceUpdatedAt:new Date().toISOString()};})(req,res,()=>{admitted=true;});
 return {status,body,admitted,reads,req};
}
test('anonymous browser never spends DEV or reaches a balance lookup',async()=>{
 const r=await attempt(false,'100');assert.equal(r.status,401);assert.equal(r.reads,0);assert.equal(r.admitted,false);
});
test('zero and failed live reads fail closed regardless of browser balance or actor',async()=>{
 for(const balance of ['0','-1','NaN',Error('ledger unavailable')]) {const r=await attempt(true,balance);assert.equal(r.admitted,false);assert(r.status>=400);}
});
test('a positive authoritative balance admits only the authenticated account',async()=>{
 const r=await attempt(true,'0.000001','someoneElse');assert.equal(r.admitted,true);assert.equal(r.req.body.buyer,'U_realAccount');
 for(const balance of ['0','-1','Infinity','NaN'])assert.throws(()=>assertFunded(balance));
});

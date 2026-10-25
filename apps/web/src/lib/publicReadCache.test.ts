import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicRead, publicReadCache } from './publicReadCache';

test('only public GETs share cached values; identity, private reads and signals bypass', () => {
  for (const p of ['/gpus', '/gpus/gpu-h/stats', '/models?gpuId=gpu-b', '/catalog/gpus', '/router/fleet']) assert.equal(isPublicRead(p), true, p);
  for (const p of ['/wallet/me', '/portfolio/me', '/account/DEV', '/credit/devnet/address', '/router/orders', '/models/../wallet/me']) assert.equal(isPublicRead(p), false, p);
  for (const init of [{ method:'POST' }, { cache:'no-store' }, { headers:{Authorization:'Bearer private'} }, {signal: new AbortController().signal}] as RequestInit[]) assert.equal(isPublicRead('/models', init), false);
});

test('concurrent misses deduplicate, stale reads refresh once, and expired reads wait', async () => {
  let now=0, calls=0;
  const cache=publicReadCache(10,30,2,()=>now);
  const load=async()=>++calls;
  assert.deepEqual(await Promise.all([cache.get('x',load),cache.get('x',load)]),[1,1]);
  now=12;
  assert.deepEqual(await Promise.all([cache.get('x',load),cache.get('x',load)]),[1,1]);
  await new Promise(r=>setTimeout(r,0));
  assert.equal(calls,2);
  now=50;
  assert.equal(await cache.get('x',load),3);
});

test('writes invalidate pending pre-write values and errors are never cached', async () => {
  const cache=publicReadCache();
  let finish!:(x:number)=>void;
  const old=cache.get('x',()=>new Promise<number>(r=>finish=r));
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.get('x',async()=>2),2);
  finish(1); await old;
  assert.equal(await cache.get('x',async()=>3),2);
  await assert.rejects(cache.get('bad',async()=>{throw Error('offline')}));
  assert.equal(await cache.get('bad',async()=>4),4);
});

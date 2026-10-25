export type QuoteLevel = { price: string; qty: string };
// Inventory and cash are actual ledger balances. Wider levels carry more size.
export function liquidityLadder(reference: number, inventory: number, cash: number, count = 5) {
  if (![reference, inventory, cash].every(Number.isFinite) || reference <= 0 || inventory < 0 || cash < 0 || !Number.isInteger(count) || count < 1 || count > 10) throw new Error('Invalid liquidity inputs');
  const weights = Array.from({ length: count }, (_, i) => i + 2);
  const total = weights.reduce((a,b)=>a+b,0);
  const asks: QuoteLevel[] = [], bids: QuoteLevel[] = [];
  const inventoryBudget = Math.min(inventory * 0.8, 200);
  const bidBudget = Math.min(cash * 0.8, reference * 100);
  for (let i=0;i<count;i++) {
    const distance=0.015+i*0.0075;
    const ask=reference*(1+distance), bid=reference*(1-distance);
    const askQty=Math.floor(inventoryBudget*weights[i]/total*1e6)/1e6;
    const bidQty=Math.floor(bidBudget*weights[i]/total/bid*1e6)/1e6;
    if(askQty>0) asks.push({price:ask.toFixed(6),qty:askQty.toFixed(6)});
    if(bidQty>0) bids.push({price:bid.toFixed(6),qty:bidQty.toFixed(6)});
  }
  return {asks,bids};
}

export async function confirmedLiquidityUpdates(cancellations: Array<() => Promise<{ hash: string; validated: boolean; result: string }>>, placements: Array<() => Promise<{ hash: string; validated: boolean; result: string }>>) {
  const hashes: string[] = [];
  for (const submit of [...cancellations, ...placements]) {
    const tx = await submit();
    if (!tx.validated || tx.result !== "tesSUCCESS") throw new Error("The ledger did not confirm the liquidity update");
    hashes.push(tx.hash);
  }
  return hashes;
}

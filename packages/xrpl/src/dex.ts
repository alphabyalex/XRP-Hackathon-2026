import { GPUS, type AccountName, type GpuId } from "@moonshift/shared";
import type {
  Offer,
  TxResult,
  BuySharesParams,
  SellSharesParams,
  BuyContractsParams,
} from "@moonshift/shared";
import { OfferCreateFlags, getBalanceChanges, type OfferCancel, type OfferCreate } from "xrpl";
import { getClient, submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet, loadAccountsJson } from "./wallets.js";

function getDomainIdIfConfigured(): string | undefined {
  if (process.env.PERMISSIONED_SHARES === "1") {
    const file = loadAccountsJson() as any;
    return file?.DomainID || undefined;
  }
  return undefined;
}

export async function listShareOffers(gpuId: GpuId): Promise<Offer[]> {
  const client = await getClient();
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${gpuId}`);

  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  try {
    const res = await client.request({
      command: "book_offers",
      taker_gets: { currency: gpu.shareCode, issuer: shareIssuer },
      taker_pays: { currency: "TDX", issuer: tdxIssuer },
      ledger_index: "validated",
    });

    return (res.result.offers || []).map((o: any) => ({
      account: o.Account,
      seq: o.Sequence,
      takerGets: o.TakerGets,
      takerPays: o.TakerPays,
    }));
  } catch {
    return [];
  }
}

export async function buyShares(p: BuySharesParams): Promise<TxResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const buyerWallet = getAccountWallet(p.buyer);
  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const totalCostTdx = (Number(p.qty) * Number(p.maxPricePerShare)).toFixed(6);
  const domainId = getDomainIdIfConfigured();

  const offer: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: buyerWallet.address,
    TakerGets: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: totalCostTdx,
    },
    TakerPays: {
      currency: gpu.shareCode,
      issuer: shareIssuer,
      value: p.qty,
    },
    Flags: OfferCreateFlags.tfImmediateOrCancel,
    ...(domainId ? { DomainID: domainId } : {}),
  };

  return submitTx(buyerWallet, offer);
}

export async function sellShares(p: SellSharesParams): Promise<TxResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const sellerWallet = getAccountWallet(p.seller);
  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const totalTdx = (Number(p.qty) * Number(p.pricePerShare)).toFixed(6);
  const domainId = getDomainIdIfConfigured();

  const offer: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: sellerWallet.address,
    TakerGets: {
      currency: gpu.shareCode,
      issuer: shareIssuer,
      value: p.qty,
    },
    TakerPays: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: totalTdx,
    },
    ...(domainId ? { DomainID: domainId } : {}),
  };

  return submitTx(sellerWallet, offer);
}

export async function listContractOffers(gpuId: GpuId): Promise<Offer[]> {
  const client = await getClient();
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${gpuId}`);

  const contractIssuer = getAccountAddress("CONTRACT_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  try {
    const res = await client.request({
      command: "book_offers",
      taker_gets: { currency: gpu.contractCode, issuer: contractIssuer },
      taker_pays: { currency: "TDX", issuer: tdxIssuer },
      ledger_index: "validated",
    });

    return (res.result.offers || []).map((o: any) => ({
      account: o.Account,
      seq: o.Sequence,
      takerGets: o.TakerGets,
      takerPays: o.TakerPays,
    }));
  } catch {
    return [];
  }
}

export async function buyContracts(p: BuyContractsParams): Promise<TxResult> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const buyerWallet = getAccountWallet(p.buyer);
  const contractIssuer = getAccountAddress("CONTRACT_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");

  const totalCostTdx = (Number(p.qty) * Number(p.maxPrice)).toFixed(6);

  const offer: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: buyerWallet.address,
    TakerGets: {
      currency: "TDX",
      issuer: tdxIssuer,
      value: totalCostTdx,
    },
    TakerPays: {
      currency: gpu.contractCode,
      issuer: contractIssuer,
      value: p.qty,
    },
    Flags: OfferCreateFlags.tfImmediateOrCancel,
  };

  return submitTx(buyerWallet, offer);
}

// ---------------------------------------------------------------------------
// Share prices from the order book
// ---------------------------------------------------------------------------

const amountValue = (a: unknown): number => (typeof a === "object" && a ? Number((a as { value?: string }).value ?? 0) : 0);

export interface ShareBook {
  // TDX per share; null when that side of the book is empty
  bestBid: string | null;
  bestAsk: string | null;
}

// Best bid and ask for one GPU's shares, from both sides of the book
// (funded amounts only, so an offer its owner can no longer fill is skipped).
export async function getShareBook(gpuId: GpuId): Promise<ShareBook> {
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${gpuId}`);
  const client = await getClient();
  type Issue = { currency: string; issuer: string };
  const share: Issue = { currency: gpu.shareCode, issuer: getAccountAddress("SHARE_ISSUER") };
  const tdx: Issue = { currency: "TDX", issuer: getAccountAddress("TDX_ISSUER") };
  const side = async (takerGets: Issue, takerPays: Issue) =>
    ((await client.request({ command: "book_offers", taker_gets: takerGets, taker_pays: takerPays, ledger_index: "validated", limit: 20 } as any)).result as any)
      .offers as any[];
  const [asks, bids] = await Promise.all([side(share, tdx), side(tdx, share)]);
  const funded = (o: any, key: "TakerGets" | "TakerPays") =>
    key === "TakerGets" ? amountValue(o.taker_gets_funded ?? o.TakerGets) : amountValue(o.taker_pays_funded ?? o.TakerPays);
  // asks: TakerGets shares, TakerPays TDX. bids: TakerGets TDX, TakerPays shares.
  const askPrices = asks.filter((o) => funded(o, "TakerGets") > 1e-6).map((o) => amountValue(o.TakerPays) / amountValue(o.TakerGets));
  const bidPrices = bids.filter((o) => funded(o, "TakerGets") > 1e-6).map((o) => amountValue(o.TakerGets) / amountValue(o.TakerPays));
  const fix = (n: number) => (Number.isFinite(n) ? n.toFixed(6) : null);
  return {
    bestAsk: askPrices.length ? fix(Math.min(...askPrices)) : null,
    bestBid: bidPrices.length ? fix(Math.max(...bidPrices)) : null,
  };
}

// Keep one resting offer for `account` on one side of a GPU's share book at
// `price` TDX per share: kept when within `tolerance`, otherwise cancelled
// and placed again. Passive, so it rests instead of consuming an offer at the
// same price.
export async function requoteShareOffer(p: {
  account: AccountName;
  gpuId: GpuId;
  side: "ask" | "bid";
  price: string;
  qty: string;
  tolerance?: number;
}): Promise<{ action: "kept" | "placed" | "replaced" | "skipped"; price: string; hashes: string[] }> {
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);
  const wallet = getAccountWallet(p.account);
  const client = await getClient();
  const shareIssuer = getAccountAddress("SHARE_ISSUER");
  const tdxIssuer = getAccountAddress("TDX_ISSUER");
  const isAsk = p.side === "ask";
  const res = await client.request({ command: "account_offers", account: wallet.address, ledger_index: "validated" });
  const mine = (res.result.offers ?? []).filter((o: any) =>
    isAsk
      ? typeof o.taker_gets === "object" && o.taker_gets.currency === gpu.shareCode && typeof o.taker_pays === "object" && o.taker_pays.currency === "TDX"
      : typeof o.taker_gets === "object" && o.taker_gets.currency === "TDX" && typeof o.taker_pays === "object" && o.taker_pays.currency === gpu.shareCode
  ) as any[];
  const target = Number(p.price);
  const priceOf = (o: any) => (isAsk ? amountValue(o.taker_pays) / amountValue(o.taker_gets) : amountValue(o.taker_gets) / amountValue(o.taker_pays));
  const tol = p.tolerance ?? 0.01;
  // Kept only when both the price and the size still match: shares returned to a treasury (seized
  // collateral) or a partly filled offer must be re-listed, not left out of the book.
  const sizeOf = (o: any) => amountValue(isAsk ? o.taker_gets : o.taker_pays);
  const sameSize = (o: any) => Math.abs(sizeOf(o) - Number(p.qty)) <= Math.max(1e-6, Number(p.qty) * tol);
  if (mine.length === 1 && Math.abs(priceOf(mine[0]) / target - 1) <= tol && sameSize(mine[0]))
    return { action: "kept", price: priceOf(mine[0]).toFixed(6), hashes: [] };
  if (!(Number(p.qty) > 0)) return { action: "skipped", price: p.price, hashes: [] };

  const hashes: string[] = [];
  for (const o of mine) {
    const tx = await submitTx(wallet, { TransactionType: "OfferCancel", Account: wallet.address, OfferSequence: o.seq } as OfferCancel);
    hashes.push(tx.hash);
  }
  const shares = { currency: gpu.shareCode, issuer: shareIssuer, value: Number(p.qty).toFixed(6) };
  const tdx = { currency: "TDX", issuer: tdxIssuer, value: (Number(p.qty) * target).toFixed(6) };
  const domainId = getDomainIdIfConfigured();
  const offer: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: wallet.address,
    TakerGets: isAsk ? shares : tdx,
    TakerPays: isAsk ? tdx : shares,
    Flags: OfferCreateFlags.tfPassive,
    ...(domainId ? { DomainID: domainId } : {}),
  };
  hashes.push((await submitTx(wallet, offer)).hash);
  return { action: mine.length ? "replaced" : "placed", price: target.toFixed(6), hashes };
}

// What a share trade actually filled at, from the transaction's balance
// changes for `account`: shares moved and TDX paid or received.
export async function shareFill(hash: string, address: string, gpuId: GpuId): Promise<{ price: string; qty: string; side: "buy" | "sell" } | null> {
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) return null;
  const client = await getClient();
  const r = await client.request({ command: "tx", transaction: hash });
  const meta = (r.result as any).meta;
  if (!meta || typeof meta !== "object") return null;
  const changes = getBalanceChanges(meta).find((c) => c.account === address)?.balances ?? [];
  const sharesDelta = changes.filter((b) => b.currency === gpu.shareCode).reduce((s, b) => s + Number(b.value), 0);
  const tdxDelta = changes.filter((b) => b.currency === "TDX").reduce((s, b) => s + Number(b.value), 0);
  if (Math.abs(sharesDelta) < 1e-9 || Math.abs(tdxDelta) < 1e-9) return null;
  return {
    price: (Math.abs(tdxDelta) / Math.abs(sharesDelta)).toFixed(6),
    qty: Math.abs(sharesDelta).toFixed(6),
    side: sharesDelta > 0 ? "buy" : "sell",
  };
}

import { GPUS, type GpuId } from "@moonshift/shared";
import type {
  Offer,
  TxResult,
  BuySharesParams,
  SellSharesParams,
  BuyContractsParams,
} from "@moonshift/shared";
import { OfferCreateFlags, type OfferCreate } from "xrpl";
import { getClient, submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";

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

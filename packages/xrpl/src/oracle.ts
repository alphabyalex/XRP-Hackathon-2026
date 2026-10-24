import { GPUS, brand } from "@moonshift/shared";
import type { PublishOracleParams, TxResult } from "@moonshift/shared";
import { isoTimeToRippleTime, type OracleSet } from "xrpl";
import { getClient, submitTx } from "./client.js";
import { getAccountAddress, getAccountWallet } from "./wallets.js";

export async function publishOracle(p: PublishOracleParams): Promise<TxResult> {
  const oracleWallet = getAccountWallet("ORACLE");
  const gpu = GPUS.find((g) => g.id === p.gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${p.gpuId}`);

  const oracleDocId = p.gpuId === "gpu-a" ? 1 : 2;

  // Scale is 4 decimal places (multiply by 10,000)
  const navPrice = Math.round(Number(p.navPerShare) * 10000);
  const contractPrice = Math.round(Number(p.gpuHourPrice) * 10000);
  const utlPrice = Math.round(Number(p.utilizationPct) * 10000);

  const tx: OracleSet = {
    TransactionType: "OracleSet",
    Account: oracleWallet.address,
    OracleDocumentID: oracleDocId,
    Provider: Buffer.from(brand.name, "utf8").toString("hex").toUpperCase(),
    AssetClass: Buffer.from("compute", "utf8").toString("hex").toUpperCase(),
    LastUpdateTime: Math.floor(Date.now() / 1000),
    PriceDataSeries: [
      {
        PriceData: {
          BaseAsset: gpu.shareCode,
          QuoteAsset: "USD",
          AssetPrice: navPrice,
          Scale: 4,
        },
      },
      {
        PriceData: {
          BaseAsset: gpu.contractCode,
          QuoteAsset: "USD",
          AssetPrice: contractPrice,
          Scale: 4,
        },
      },
      {
        PriceData: {
          BaseAsset: "UTL",
          QuoteAsset: "PCT",
          AssetPrice: utlPrice,
          Scale: 4,
        },
      },
    ],
  };

  return submitTx(oracleWallet, tx);
}

export interface OracleReading {
  gpuId: string;
  navPerShare: string; // TDX per GPU share, the collateral price
  gpuHourPrice: string;
  utilizationPct: string;
  lastUpdateTime: string | null; // ISO
  documentId: number;
}

// Read the GPU's on-ledger oracle (OracleSet by the ORACLE account). Returns
// null if it was never published on this network.
export async function readOracle(gpuId: string): Promise<OracleReading | null> {
  const gpu = GPUS.find((g) => g.id === gpuId);
  if (!gpu) throw new Error(`Unknown gpuId: ${gpuId}`);
  const documentId = gpuId === "gpu-a" ? 1 : 2;
  const client = await getClient();
  let node: any;
  try {
    const res = await client.request({
      command: "ledger_entry",
      oracle: { account: getAccountAddress("ORACLE"), oracle_document_id: documentId },
      ledger_index: "validated",
    } as any);
    node = (res.result as any).node;
  } catch {
    return null;
  }
  // AssetPrice is a UInt64, rendered as a hex string in JSON.
  const value = (base: string): string => {
    const pd = (node.PriceDataSeries ?? []).map((x: any) => x.PriceData).find((x: any) => x.BaseAsset === base);
    if (!pd || pd.AssetPrice === undefined) return "0.000000";
    const raw = typeof pd.AssetPrice === "string" ? parseInt(pd.AssetPrice, 16) : Number(pd.AssetPrice);
    return (raw / 10 ** Number(pd.Scale ?? 0)).toFixed(6);
  };
  return {
    gpuId,
    navPerShare: value(gpu.shareCode),
    gpuHourPrice: value(gpu.contractCode),
    utilizationPct: value("UTL"),
    lastUpdateTime: node.LastUpdateTime ? new Date(Number(node.LastUpdateTime) * 1000).toISOString() : null,
    documentId,
  };
}

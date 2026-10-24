import { GPUS, brand } from "@moonshift/shared";
import type { PublishOracleParams, TxResult } from "@moonshift/shared";
import { isoTimeToRippleTime, type OracleSet } from "xrpl";
import { submitTx } from "./client.js";
import { getAccountWallet } from "./wallets.js";

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

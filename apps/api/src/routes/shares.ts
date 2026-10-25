import { Router } from "express";
import type { GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import { logTx } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import { recordTrade, sharePrice } from "../sharePrice.js";
import { getAccountAddress } from "@moonshift/xrpl";
import { asActor } from "../middleware/session.js";

export const sharesRouter = Router();

sharesRouter.post("/shares/buy", asActor("body", "buyer"), async (req, res) => {
  const { buyer, gpuId, qty } = req.body as { buyer: string; gpuId: GpuId; qty: string };
  if (!buyer || !gpuId || !qty) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "buyer, gpuId, qty required" } });
    return;
  }
  try {
    // A market buy fills at the best asks up to 5% over the share price, never at any price.
    const limit = (Number((await sharePrice(gpuId)).price) * 1.05).toFixed(6);
    const tx = await xrpl.buyShares({ buyer: buyer as any, gpuId, qty, maxPricePerShare: limit });
    logTx(tx, "buyShares", buyer, `${buyer} bought ${qty} shares of ${gpuId}`);
    if (tx.result === "tesSUCCESS") await recordTrade(gpuId, tx.hash, getAccountAddress(buyer as any));
    broadcast("tx", { hash: tx.hash, kind: "buyShares", account: buyer });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

sharesRouter.post("/shares/sell", asActor("body", "seller"), async (req, res) => {
  const { seller, gpuId, qty, price } = req.body as { seller: string; gpuId: GpuId; qty: string; price: string };
  if (!seller || !gpuId || !qty || !price) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "seller, gpuId, qty, price required" } });
    return;
  }
  try {
    const tx = await xrpl.sellShares({ seller: seller as any, gpuId, qty, pricePerShare: price });
    logTx(tx, "sellShares", seller, `${seller} sold ${qty} shares of ${gpuId}`);
    if (tx.result === "tesSUCCESS") await recordTrade(gpuId, tx.hash, getAccountAddress(seller as any));
    broadcast("tx", { hash: tx.hash, kind: "sellShares", account: seller });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

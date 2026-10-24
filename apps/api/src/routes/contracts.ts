import { Router } from "express";
import { randomUUID } from "crypto";
import type { GpuId } from "@moonshift/shared";
import * as xrpl from "../adapters/xrplAdapter.js";
import * as compute from "../adapters/computeClient.js";
import * as pricing from "../adapters/pricingClient.js";
import { db } from "../db/db.js";
import { logTx, addRevenue } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import { asActor } from "../middleware/session.js";

export const contractsRouter = Router();

contractsRouter.post("/contracts/buy", asActor("body", "buyer"), async (req, res) => {
  const { buyer, gpuId, qty } = req.body as { buyer: string; gpuId: GpuId; qty: string };
  if (!buyer || !gpuId || !qty) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "buyer, gpuId, qty required" } });
    return;
  }
  try {
    const tx = await xrpl.buyContracts({ buyer: buyer as any, gpuId, qty, maxPrice: "999999" });
    if (tx.result === "tesSUCCESS") {
      const price = await pricing.getContractPrice(gpuId, new Date().toISOString());
      const amount = (Number(qty) * Number(price.price_per_slot)).toFixed(6);
      addRevenue(gpuId, "contract", amount, tx.hash);
    }
    logTx(tx, "buyContracts", buyer, `${buyer} bought ${qty} GPU-hour contract(s) on ${gpuId}`);
    broadcast("tx", { hash: tx.hash, kind: "buyContracts", account: buyer });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

contractsRouter.post("/contracts/redeem", asActor("body", "holder"), async (req, res) => {
  const { holder, gpuId, qty, slotStart } = req.body as {
    holder: string;
    gpuId: GpuId;
    qty: string;
    slotStart: string;
  };
  if (!holder || !gpuId || !qty || !slotStart) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "holder, gpuId, qty, slotStart required" } });
    return;
  }

  const redemptionId = `redemption_${randomUUID()}`;
  const slots = Number(qty);

  // Book first with a short hold, then burn. Never burn if the slot is taken.
  let bookingId: string;
  try {
    const booking = await compute.createBooking({
      gpu_id: gpuId,
      slot_start: slotStart,
      slots,
      redemption_id: redemptionId,
      holder,
    });
    bookingId = booking.booking_id;
  } catch (err: any) {
    if (err.code === "UPSTREAM_ERROR" && err.message === "SLOT_TAKEN") {
      res.status(409).json({ error: { code: "SLOT_TAKEN", message: "that slot is already booked" } });
      return;
    }
    res.status(502).json({ error: { code: "UPSTREAM_ERROR", message: err.message } });
    return;
  }

  try {
    const tx = await xrpl.redeemContracts({ holder: holder as any, gpuId, qty, slotStart });
    const slotEnd = compute.slotEndFor(slotStart, slots);

    db.prepare(
      `INSERT INTO redemptions (id, gpu_id, holder, qty, slot_start, slots, tx_hash, booking_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(redemptionId, gpuId, holder, qty, slotStart, slots, tx.hash, bookingId);
    db.prepare(
      `INSERT INTO bookings (id, gpu_id, slot_start, slot_end, holder, redemption_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(bookingId, gpuId, slotStart, slotEnd, holder, redemptionId);

    logTx(tx, "redeemContracts", holder, `${holder} redeemed ${qty} contract(s) on ${gpuId} for ${slotStart}`);
    broadcast("calendar", { gpu_id: gpuId, start: slotStart, end: slotEnd, kind: "BOOKED", ref: redemptionId });

    res.json({ redemptionId, bookingId, slotStart, slotEnd });
  } catch (err) {
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

import { Router } from "express";
import * as compute from "../adapters/computeClient.js";
import { ComputeError } from "../adapters/computeClient.js";
import { recordUsage } from "../db/helpers.js";
import { broadcast } from "../sse.js";
import type { InferenceChatBody } from "@moonshift/shared";

export const inferenceRouter = Router();

inferenceRouter.post("/inference/chat", async (req, res) => {
  const body = req.body as InferenceChatBody;
  if (!body.messages?.length) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "messages required" } });
    return;
  }
  const buyer = body.buyer ?? "DEV";
  const startedAt = new Date().toISOString();

  try {
    const result = await compute.chatCompletions({ messages: body.messages }, buyer, body.bookingId);
    const finishedAt = new Date().toISOString();

    recordUsage({
      request_id: result.x_ms.request_id,
      gpu_id: result.x_ms.gpu_id,
      buyer,
      booking_id: body.bookingId ?? null,
      input_tokens: result.x_ms.input_tokens,
      output_tokens: result.x_ms.output_tokens,
      charge: result.x_ms.charge,
      started_at: startedAt,
      finished_at: finishedAt,
      simulated: result.x_ms.simulated,
    });
    broadcast("usage", result.x_ms);

    res.json(result);
  } catch (err) {
    if (err instanceof ComputeError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

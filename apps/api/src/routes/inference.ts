import { Router } from "express";
import * as compute from "../adapters/computeClient.js";
import { ComputeError } from "../adapters/computeClient.js";
import { routerPublic } from "./router.js";
import type { InferenceChatBody } from "@moonshift/shared";

export const inferenceRouter = Router();

inferenceRouter.post("/inference/chat", async (req, res, next) => {
  const body = req.body as InferenceChatBody;
  if (!body.messages?.length) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "messages required" } });
    return;
  }
  // Unreserved public inference must use the same real payment/cap/refund path
  // as task checkout. A usage meter alone is not a settled ledger payment.
  if (!body.bookingId) {
    const sendJson = res.json.bind(res);
    res.json = ((result: any) => {
      if (!result?.choices) return sendJson(result);
      return sendJson({ ...result, x_ms: {
        ...result.x_ms, request_id: result.x_ms.order_id, gpu_id: result.x_ms.gpus?.[0]?.toLowerCase() ?? null,
        model: result.model, charge: result.x_ms.price_usdc,
        input_tokens: null, output_tokens: result.usage?.completion_tokens ?? null,
        routed_reason: "Live GPU task with validated settlement", simulated: false,
      } });
    }) as typeof res.json;
    req.url = "/v1/chat/completions";
    routerPublic(req, res, next);
    return;
  }
  // The signed-in account pays; the developer playground account otherwise. Never a name from the browser.
  const buyer = req.user?.name ?? "DEV";
  try {
    const result = await compute.chatCompletions({ messages: body.messages }, buyer, body.bookingId);
    // Compute's UsageReporter sends the metered event once. Recording it here
    // as well would count the same request twice in downstream revenue.
    res.json(result);
  } catch (err) {
    if (err instanceof ComputeError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
  }
});

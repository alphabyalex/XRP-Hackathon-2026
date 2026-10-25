// Order router (services/router, owner Lucy). Small and isolated: everything router-related in the
// api lives in this file, mounted with two lines in index.ts.
//
//   public  /router/*                 proxy to ROUTER_URL (quote, orders, order events SSE, fleet, catalog)
//   public  POST /v1/chat/completions OpenAI-compatible; "priority": cheapest | balanced | fastest
//   internal POST /internal/router/pay  one TDX Payment between Moonshift accounts, signed with the
//                                     packages/xrpl wallets (devnet). Used for MS_ORDER, MS_SETTLE, MS_REFUND.

import { Router, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import type { Payment } from "xrpl";
import * as realXrpl from "@moonshift/xrpl";
import { networkName, txExplorerUrl } from "@moonshift/shared";
import type { AccountName } from "@moonshift/shared";
import { internalHeaders } from "../adapters/serviceFetch.js";
import { actorFor, asActor } from "../middleware/session.js";
import { requirePromptFunding } from "../middleware/funding.js";
import { getRentalCatalog } from "../marketData/rentalCatalog.js";
import { selectServingGpu } from "./servingModel.js";

const ROUTER_URL = () => (process.env.ROUTER_URL ?? "http://localhost:7200").replace(/\/$/, "");
const MAX_PAYMENT_TDX = 1000;
const MEMO_TYPES = new Set(["MS_ORDER", "MS_SETTLE", "MS_REFUND"]);

export const routerPublic = Router();
export const routerInternal = Router();

// ---- proxy ------------------------------------------------------------------------------------

async function proxy(req: Request, res: Response, path: string): Promise<void> {
  try {
    const r = await fetch(`${ROUTER_URL()}${path}`, {
      method: req.method,
      headers: internalHeaders(true),
      body: req.method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
    });
    res.status(r.status);
    res.type("application/json").send(await r.text());
  } catch {
    res.status(503).json({ error: { code: "ROUTER_UNAVAILABLE", message: "The order router is not reachable." } });
  }
}

routerPublic.get("/router/catalog", (req, res) => proxy(req, res, `/catalog${req.url.slice(req.path.length)}`));
routerPublic.get("/router/fleet", (req, res) => proxy(req, res, "/fleet"));
routerPublic.get("/router/health", (req, res) => proxy(req, res, "/health"));
routerPublic.post("/router/quote", (req, res) => proxy(req, res, "/quote"));
// The buyer is the signed-in account (never a name from the browser).
routerPublic.post("/router/orders", asActor("body", "buyer"), requirePromptFunding, (req, res) => {
  if (req.body?.taskType && req.body.taskType !== "inference") {
    res.status(409).json({ error: { code: "TASK_TYPE_UNAVAILABLE", message: "The current GPU endpoint supports text inference only." } });
    return;
  }
  return proxy(req, res, "/orders");
});
routerPublic.get("/router/orders", (req, res) => proxy(req, res, `/orders${req.url.slice(req.path.length)}`));

// Raise the cap of, or cancel, one of the signed-in account's own orders.
async function ownOrder(req: Request, res: Response): Promise<boolean> {
  let who: string;
  try {
    who = actorFor(req);
  } catch (e) {
    res.status(401).json({ error: { code: "NOT_CONNECTED", message: (e as Error).message } });
    return false;
  }
  try {
    const r = await fetch(`${ROUTER_URL()}/orders/${encodeURIComponent(req.params.id)}`, { headers: internalHeaders(true) });
    const order = (await r.json()) as { buyer?: string };
    if (r.ok && order.buyer === who) return true;
    res.status(r.ok ? 403 : r.status).json({ error: { code: "NOT_YOURS", message: "This order belongs to another account." } });
  } catch {
    res.status(503).json({ error: { code: "ROUTER_UNAVAILABLE", message: "The order router is not reachable." } });
  }
  return false;
}
routerPublic.post("/router/orders/:id/cap", async (req, res) => {
  if (await ownOrder(req, res)) await proxy(req, res, `/orders/${encodeURIComponent(req.params.id)}/cap`);
});
routerPublic.post("/router/orders/:id/cancel", async (req, res) => {
  if (await ownOrder(req, res)) await proxy(req, res, `/orders/${encodeURIComponent(req.params.id)}/cancel`);
});
routerPublic.get("/router/orders/:id", (req, res) => proxy(req, res, `/orders/${encodeURIComponent(req.params.id)}`));

// Reclaim is an operator action: gated by ADMIN_KEY when one is set.
routerPublic.post("/router/fleet/:id/reclaim", (req, res) => {
  const expected = process.env.ADMIN_KEY;
  if (expected && req.header("X-MS-Admin-Key") !== expected) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "missing or bad X-MS-Admin-Key" } });
    return;
  }
  return proxy(req, res, `/fleet/${encodeURIComponent(req.params.id)}/reclaim`);
});

// Server-sent events pass straight through.
routerPublic.get("/router/orders/:id/events", async (req, res) => {
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  try {
    const r = await fetch(`${ROUTER_URL()}/orders/${encodeURIComponent(req.params.id)}/events`, {
      headers: internalHeaders(),
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) {
      res.status(r.status).type("application/json").send(await r.text());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.status(503).json({ error: { code: "ROUTER_UNAVAILABLE", message: "The order router is not reachable." } });
    else res.end();
  }
});

// ---- OpenAI-compatible chat with a routing priority -------------------------------------------------

type Msg = { role: "system" | "user" | "assistant"; content: string };

routerPublic.post("/v1/chat/completions", requirePromptFunding, async (req, res) => {
  const body = req.body as { model?: string; messages?: Msg[]; max_tokens?: number; priority?: string; gpuId?: string; gpu_id?: string };
  const pinnedGpu = body.gpuId ?? body.gpu_id;
  if (pinnedGpu !== undefined && (typeof pinnedGpu !== "string" || !/^gpu-[a-z]$/.test(pinnedGpu))) {
    res.status(400).json({ error: { code: "GPU_NOT_SERVING", message: "This GPU is not currently serving this model." } });
    return;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "messages required" } });
    return;
  }
  const priority = body.priority ?? "balanced";
  if (!["cheapest", "balanced", "fastest"].includes(priority)) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "priority must be cheapest, balanced or fastest" } });
    return;
  }
  const buyer = req.body.buyer;
  try {
    const catalog = await getRentalCatalog();
    const selected = selectServingGpu(catalog.gpus, pinnedGpu, body.model);
    if (!selected) {
      res.status(503).json({ error: { code: "MODEL_OFFLINE", message: "The requested model endpoint is currently offline." } });
      return;
    }
    const servingModel = selected.modelId ?? `Qwen/${selected.model}`;
    const created = await fetch(`${ROUTER_URL()}/orders`, {
      method: "POST",
      headers: internalHeaders(true),
      body: JSON.stringify({ kind: "inference", mode: priority, buyer, maxTokens: body.max_tokens ?? 128, requests: [body.messages], gpuId: selected.id }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) {
      res.status(created.status).type("application/json").send(await created.text());
      return;
    }
    let order = (await created.json()) as any;
    const deadline = Date.now() + 120_000;
    while (!["settled", "failed", "cancelled"].includes(order.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      order = await (await fetch(`${ROUTER_URL()}/orders/${order.orderId}`, { headers: internalHeaders(), signal: AbortSignal.timeout(5000) })).json();
    }
    if (["failed", "cancelled"].includes(order.status)) {
      res.status(503).json({ error: { code: "ORDER_FAILED", message: "The order could not be completed." } });
      return;
    }
    if (order.status !== "settled") {
      res.status(504).json({ error: { code: "ORDER_PENDING", message: "The order is still pending. Check its status before submitting again.", orderId: order.orderId } });
      return;
    }
    const content: string = order.output?.[0] ?? "";
    const tokens = Math.round(order.progress?.done ?? 0);
    res.json({
      id: `chatcmpl_${order.orderId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: servingModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: null, completion_tokens: tokens, total_tokens: null },
      x_ms: {
        order_id: order.orderId,
        priority,
        price_usdc: order.charged,
        estimate_usdc: order.estimateUsdc ?? order.priceUsdc,
        cap_usdc: order.capUsdc,
        settlement_status: order.status,
        gpus: [...new Set((order.segments ?? []).map((s: any) => s.label))],
        providers: [...new Set((order.segments ?? []).map((s: any) => s.provider))],
        moves: order.moves ?? [],
        payment: order.payment?.hash ?? null,
        explorer_url: order.payment?.explorerUrl ?? null,
      },
    });
  } catch {
    res.status(503).json({ error: { code: "ROUTER_UNAVAILABLE", message: "The order router is not reachable." } });
  }
});

// ---- internal: one TDX payment for the router's settlement --------------------------------------------

const accountLocks = new Map<string, Promise<unknown>>();
function serialized<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(account) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  accountLocks.set(account, next.catch(() => undefined));
  return next;
}

routerInternal.post("/router/pay", async (req, res) => {
  const { from, to, amount, memoType, memo } = req.body as {
    from: AccountName; to: AccountName; amount: string; memoType: string; memo: Record<string, unknown>;
  };
  const value = Number(amount);
  if (!from || !to || from === to || !Number.isFinite(value) || value <= 0 || value > MAX_PAYMENT_TDX || !MEMO_TYPES.has(memoType)) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "from, to (different), amount (0, 1000] and a router memo type are required" } });
    return;
  }
  const memoData = JSON.stringify({ type: memoType, ...(memo ?? {}) });
  if (process.env.MOCK_XRPL !== "0") {
    const hash = randomBytes(32).toString("hex").toUpperCase();
    res.json({ hash, result: "tesSUCCESS", validated: true, explorerUrl: txExplorerUrl(hash) });
    return;
  }
  try {
    networkName(); // devnet or testnet only; throws for anything else
    const tx = await serialized(from, async () => {
      const wallet = realXrpl.getAccountWallet(from);
      const payment: Payment = {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: realXrpl.getAccountAddress(to),
        Amount: { currency: "TDX", issuer: realXrpl.getAccountAddress("TDX_ISSUER" as AccountName), value: value.toFixed(6) },
        Memos: [{ Memo: {
          MemoType: Buffer.from("text/plain", "utf8").toString("hex").toUpperCase(),
          MemoData: Buffer.from(memoData, "utf8").toString("hex").toUpperCase(),
        } }],
      };
      const client = await realXrpl.getClient();
      const r = await client.submitAndWait(payment, { autofill: true, wallet });
      const meta = r.result.meta as { TransactionResult?: string } | undefined;
      return { hash: r.result.hash, result: meta?.TransactionResult ?? "unknown", validated: Boolean(r.result.validated) };
    });
    res.json({ ...tx, explorerUrl: txExplorerUrl(tx.hash) });
  } catch (e) {
    res.status(502).json({ error: { code: "PAYMENT_FAILED", message: (e as Error).message.slice(0, 200) } });
  }
});

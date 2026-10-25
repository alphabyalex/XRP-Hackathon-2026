// Public api routes for /docs#api. Request and response bodies follow the
// examples in contracts/ (api, router, credit, compute), trimmed to the fields
// a client needs. Amounts are decimal strings in USDC.

export type Route = {
  method: "GET" | "POST";
  path: string;
  summary: string;
  auth?: boolean;
  request?: unknown;
  response: unknown;
};

export type RouteGroup = { id: string; title: string; routes: Route[] };

const HASH = "9F3A01D7B2C64E58A1F0C3B9D2E7A6F41C8B5D0E3F2A1B9C8D7E6F5A4B3CC21E";

export const API_GROUPS: RouteGroup[] = [
  {
    id: "api-gpus",
    title: "GPUs and shares",
    routes: [
      {
        method: "GET",
        path: "/gpus",
        summary: "Every GPU that passes its health check, with its share price and the last 24 hours of revenue.",
        response: [
          {
            id: "gpu-a",
            label: "GPU A",
            hw: "NVIDIA T4 16GB",
            model: "Qwen/Qwen2.5-1.5B-Instruct",
            provider: "Akash Network",
            state: "SERVING",
            sharePrice: "48.335462",
            navPerShare: "49.071536",
            revenue24h: "0.297092",
            utilizationPct: "100",
            holdersCount: 40,
          },
        ],
      },
      {
        method: "POST",
        path: "/shares/buy",
        summary: "Buy shares of a GPU. Settles on the XRP Ledger order book and returns the validated transaction.",
        auth: true,
        request: { gpuId: "gpu-a", qty: "50" },
        response: { hash: HASH, result: "tesSUCCESS", validated: true },
      },
      {
        method: "POST",
        path: "/shares/sell",
        summary: "Sell shares back into the book.",
        auth: true,
        request: { gpuId: "gpu-a", qty: "20" },
        response: { hash: HASH, result: "tesSUCCESS", validated: true },
      },
      {
        method: "GET",
        path: "/portfolio/me",
        summary: "The signed-in account: USDC balance, shares per GPU, dividends received and loans.",
        auth: true,
        response: {
          account: "U_rsinyUoeDm6hGgBPr4n1puN6a89hVfYUq9",
          tdxBalance: "450.000000",
          shares: [{ gpuId: "gpu-a", qty: "300" }],
          dividendsReceived: "23.352900",
          loans: [],
        },
      },
    ],
  },
  {
    id: "api-router",
    title: "Compute and the router",
    routes: [
      {
        method: "POST",
        path: "/v1/chat/completions",
        summary: "OpenAI compatible. Add priority (cheapest, balanced or fastest) and the router picks the GPU. x_ms reports the GPUs used, any moves and the payment.",
        request: {
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          messages: [{ role: "user", content: "Explain VWAP in one line" }],
          max_tokens: 160,
          priority: "balanced",
        },
        response: {
          id: "chatcmpl_ord_7a3f19c2",
          object: "chat.completion",
          model: "Qwen/Qwen2.5-1.5B-Instruct",
          choices: [{ index: 0, message: { role: "assistant", content: "VWAP is the average price weighted by volume." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 11, total_tokens: 11 },
          x_ms: { order_id: "ord_7a3f19c2", priority: "balanced", price_usdc: "0.002000", gpus: ["GPU-A"], providers: ["akash"], moves: [], payment: HASH },
        },
      },
      {
        method: "POST",
        path: "/router/quote",
        summary: "Price one task in all three modes at once: cost, ETA and the GPUs each plan would use.",
        request: { kind: "inference", tokens: 1200, requests: 4, deadlineSeconds: null, budgetUsdc: null },
        response: {
          quoteId: "q_5f1c2a9e",
          default: "balanced",
          options: {
            cheapest: { mode: "cheapest", feasible: true, priceUsdc: "0.001716", etaSeconds: 36, providers: ["akash"], parts: ["<part>"] },
            balanced: { mode: "balanced", feasible: true, priceUsdc: "0.002000", etaSeconds: 12, providers: ["akash"], parts: ["<part>"] },
            fastest: { mode: "fastest", feasible: true, priceUsdc: "0.002400", etaSeconds: 9, providers: ["akash"], parts: ["<part>"] },
          },
          plansEvaluated: 312,
          catalogAsOf: "2026-10-25T08:53:39Z",
        },
      },
      {
        method: "POST",
        path: "/router/orders",
        summary: "Place a task. The price cap is set aside on the ledger first; what the task does not use is refunded at settlement.",
        auth: true,
        request: { kind: "inference", mode: "balanced", bufferPct: 25, maxTokens: 300, requests: [[{ role: "user", content: "Explain VWAP in one line" }]] },
        response: { orderId: "ord_7a3f19c2", status: "paid", mode: "balanced", priceUsdc: "0.002000", capUsdc: "0.002500" },
      },
      {
        method: "GET",
        path: "/router/orders/:id/events",
        summary: "Server-sent events for one order: quoted, paid, running, token, progress, moved, completed, settled.",
        response: [
          { event: "token", data: { orderId: "ord_7a3f19c2", request: 0, text: " weighted", index: 41 } },
          { event: "moved", data: { from: "gpu-a", to: "gpu-b", reason: "RECLAIMED", resumedAt: 180 } },
          { event: "settled", data: { orderId: "ord_7a3f19c2", refundUsdc: "0.000500" } },
        ],
      },
      {
        method: "GET",
        path: "/models",
        summary: "Every model, the GPU it runs on, VRAM, context length and price per 1M tokens. A model is serving only while its GPU passes its health check.",
        response: {
          models: [
            {
              gpuId: "gpu-a",
              modelId: "Qwen/Qwen2.5-1.5B-Instruct",
              status: "serving",
              vramGb: 5,
              contextLength: 4096,
              pricePer1MTokens: null,
              endpoint: "/v1/chat/completions",
            },
          ],
        },
      },
    ],
  },
  {
    id: "api-credit",
    title: "Lending and credit",
    routes: [
      {
        method: "GET",
        path: "/vault",
        summary: "The lending rounds: the round lending now and the round taking deposits, with assets, debt, cover and APY.",
        response: {
          investing: { round: 1, phase: "investment", assetsTotal: "6806.521531", assetsAvailable: "5608.521531", debtTotal: "1198.000000", coverAvailable: "988.500000", utilizationPct: "17.60", targetApyPct: "13.19" },
          subscribing: { round: 2, phase: "subscription", assetsTotal: "21785.000000" },
        },
      },
      {
        method: "POST",
        path: "/vault/deposit",
        summary: "Deposit USDC into the round taking deposits (an XLS-65 VaultDeposit).",
        auth: true,
        request: { amount: "250" },
        response: { round: 2, tx: { hash: HASH, result: "tesSUCCESS", validated: true } },
      },
      {
        method: "POST",
        path: "/loans/quote",
        summary: "Price a loan against GPU shares: APR, LTV with its margin call and liquidation lines, coverage and the credit profile behind it.",
        auth: true,
        request: { gpuId: "gpu-b", collateralShares: "100", principal: "200" },
        response: {
          quoteId: "8d2f0b7e-5c1a-4b2e-9d41-6a0f3e2c1b55",
          principal: "200.000000",
          collateralValue: "935.400000",
          quote: { decision: "approve", apr: "0.1180", ltv: "0.2138", maxLtv: "0.35", marginCallLtv: "0.45", liquidationLtv: "0.55", coverageRatio: "1.84" },
          terms: { termSeconds: 1141200, paymentTotal: 4 },
          credit: { score: 75, grade: "B", confidence: "high" },
        },
      },
      {
        method: "POST",
        path: "/loans/open",
        summary: "Open the quoted loan: shares are locked, then an XLS-66 LoanSet pays out the USDC. Above the approved amount the api answers 409 OVER_LIMIT and opens nothing.",
        auth: true,
        request: { quoteId: "8d2f0b7e-5c1a-4b2e-9d41-6a0f3e2c1b55" },
        response: { id: "a41c9e02", status: "open", principal: "200.000000", collateralShares: "100", apr: "0.1180", txs: { escrow: HASH, loanSet: HASH } },
      },
      {
        method: "POST",
        path: "/loans/:id/pay",
        summary: "Pay the next installment. /loans/:id/repay with mode full pays the loan off and returns the shares.",
        auth: true,
        request: { mode: "next" },
        response: { id: "a41c9e02", status: "open", txs: { pay: HASH } },
      },
      {
        method: "GET",
        path: "/credit/:network/:address",
        summary: "A credit profile for any XRP Ledger account: score, grade, confidence and every factor, each linked to the transactions behind it.",
        response: {
          address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
          source: "quicknode",
          score: 74,
          grade: "B",
          confidence: "high",
          features: { accountAgeDays: { value: 1412, points: 10, txHashes: [HASH] } },
        },
      },
      {
        method: "GET",
        path: "/events",
        summary: "One server-sent events stream for the whole product: tx, usage, dividend, loan, vault, risk and credit events.",
        response: [
          { event: "loan", data: { id: "a41c9e02", type: "margin_call" } },
          { event: "credit", data: { kind: "PROFILE_CHANGED", scoreBefore: 72, score: 75 } },
        ],
      },
    ],
  },
];

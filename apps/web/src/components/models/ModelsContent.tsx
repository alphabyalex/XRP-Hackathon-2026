"use client";
// /models: the model catalog (GET /models), a copyable OpenAI client sample
// and a live Try it box. Signed in, Try it places a real order and streams its
// token events. A verified funded session is required for every prompt.
import { useEffect, useRef, useState } from "react";
import type { ApiGpuSummary } from "@moonshift/shared";
import { apiFetch, getGpus } from "@/lib/api";
import { fmt, taskUsdc } from "@/lib/format";
import { createOrder, getOrder, MODES, orderEventsUrl, providerName, type Mode } from "@/lib/routerApi";
import { useWallet } from "@/lib/wallet";
import { txUrl } from "@/lib/lendingApi";
import { Segmented } from "../Segmented";
import { Code } from "../docs/Code";
import "../docs/docs.css";
import "./models.css";

const BASE = "https://moonshift-protocol.vercel.app/api/v1";

type Model = {
  gpuId: string;
  modelId: string;
  name: string;
  status: "serving" | "on_request" | string;
  acceptsRequests: boolean;
  vramGb: number | null;
  contextLength: number | null;
  pricePer1MTokens: string | number | null;
  currency: string;
};

function normalize(rows: any[]): Model[] {
  return rows.map((m) => ({
    gpuId: String(m.gpuId ?? ""),
    modelId: String(m.modelId ?? m.id),
    name: String(m.name ?? String(m.modelId ?? m.id).split("/").pop()),
    status: m.status ?? (m.acceptsRequests ? "serving" : "on_request"),
    acceptsRequests: m.acceptsRequests ?? m.status === "serving",
    vramGb: m.vramGb ?? null,
    contextLength: m.contextLength ?? null,
    pricePer1MTokens: m.pricePer1MTokens ?? null,
    currency: String(m.currency ?? "USD"),
  }));
}

function sample(modelId: string, priority: Mode, gpuId?: string) {
  return `import os
from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",
    api_key="unused",
    default_headers={"Cookie": os.environ["MOONSHIFT_SESSION_COOKIE"]},
)

r = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "Explain VWAP in one line"}],
    extra_body={"priority": "${priority}"${gpuId ? `, "gpuId": "${gpuId}"` : ""}},  # cheapest | balanced | fastest
)
print(r.choices[0].message.content)`;
}

type Run = {
  text: string;
  status: "idle" | "running" | "done" | "error";
  gpus: string[];
  providers: string[];
  price: string | null;
  tokens: number | null;
  payment: string | null;
  moved: string | null;
  refund: string | null;
  error: string | null;
};
const IDLE: Run = { text: "", status: "idle", gpus: [], providers: [], price: null, tokens: null, payment: null, moved: null, refund: null, error: null };

export function ModelsContent() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [gpus, setGpus] = useState<Record<string, ApiGpuSummary>>({});
  const [failed, setFailed] = useState(false);
  // false while the GPUs list stands in for GET /models (no VRAM or context yet).
  const [full, setFull] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [priority, setPriority] = useState<Mode>("balanced");
  const [prompt, setPrompt] = useState("Explain VWAP in one line");
  const [run, setRun] = useState<Run>(IDLE);
  const es = useRef<EventSource | null>(null);
  const runId = useRef(0);
  const walletState = useWallet();
  const { wallet, account, loaded, refresh } = walletState;
  const balanceFresh = Boolean(account?.balanceUpdatedAt && Date.now() - Date.parse(account.balanceUpdatedAt) >= -5000 && Date.now() - Date.parse(account.balanceUpdatedAt) <= 15000);
  const funded = Boolean(loaded && wallet?.verified && balanceFresh && Number(account?.balance) > 0);

  // The catalog and the GPUs behind it, polled every 5 s. Until GET /models
  // answers, the health-checked GPUs list stands in (each GPU's served model),
  // and /models is asked again once a minute.
  useEffect(() => {
    let alive = true;
    let missingSince = 0;
    const load = async () => {
      const askModels = !missingSince || Date.now() - missingSince > 60_000;
      const [m, g] = await Promise.all([
        askModels ? apiFetch<any>("/models").catch(() => null) : Promise.resolve(null),
        getGpus().catch(() => null),
      ]);
      if (!alive) return;
      if (g) setGpus(Object.fromEntries(g.map((x) => [x.id, x])));
      const rows = Array.isArray(m) ? m : m?.models;
      if (Array.isArray(rows)) {
        missingSince = 0;
        setFull(true);
        setModels(normalize(rows));
        setFailed(false);
      } else {
        if (askModels) missingSince = Date.now();
        if (g) {
          setFull(false);
          setModels(
            normalize(
              g
                .filter((x) => x.model)
                .map((x) => ({ gpuId: x.id, modelId: x.model, acceptsRequests: String((x as any).state ?? "").toUpperCase() === "SERVING" }))
            )
          );
          setFailed(false);
        } else setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => () => es.current?.close(), []);

  const serving = (models ?? []).filter((m) => m.acceptsRequests);
  const current = serving.find((m) => `${m.gpuId}:${m.modelId}` === selected) ?? serving[0] ?? null;

  async function tryIt() {
    if (!funded || !current?.acceptsRequests || run.status === "running" || !prompt.trim()) { void refresh(); return; }
    const my = ++runId.current;
    es.current?.close();
    setRun({ ...IDLE, status: "running" });
    const messages = [{ role: "user", content: prompt.trim() }];
    try {
      const order = await createOrder({ kind: "inference", gpuId: current.gpuId, mode: priority, maxTokens: 160, requests: [messages] });
      if (my !== runId.current) return;
      setRun((r) => ({ ...r, price: order.priceUsdc, payment: order.payment?.hash ?? null }));
      const src = new EventSource(orderEventsUrl(order.orderId));
      es.current = src;
      const parse = (e: Event) => {
        try {
          return JSON.parse((e as MessageEvent).data);
        } catch {
          return {};
        }
      };
      src.addEventListener("running", (e) => {
        const d = parse(e);
        setRun((r) => ({
          ...r,
          gpus: d.label && !r.gpus.includes(d.label) ? [...r.gpus, d.label] : r.gpus,
          providers: d.provider && !r.providers.includes(d.provider) ? [...r.providers, d.provider] : r.providers,
        }));
      });
      src.addEventListener("token", (e) => {
        const d = parse(e);
        if (typeof d.text === "string") setRun((r) => ({ ...r, text: r.text + d.text }));
      });
      src.addEventListener("moved", (e) => {
        const d = parse(e);
        setRun((r) => ({ ...r, moved: `Moved to ${d.toLabel ?? d.to}, resumed from the text already written.` }));
      });
      src.addEventListener("progress", (e) => {
        const d = parse(e);
        if (d.unit === "tokens") setRun((r) => ({ ...r, tokens: Math.round(d.done) }));
      });
      src.addEventListener("settled", (e) => {
        void refresh();
        const d = parse(e);
        const refund = d.refund?.amountUsdc ?? d.refundUsdc ?? null;
        src.close();
        setRun((r) => ({
          ...r,
          status: r.status === "error" || !r.text ? "error" : "done",
          refund: refund && Number(refund) > 0 ? String(refund) : r.refund,
          error: r.status === "error" || !r.text ? "The GPU could not finish this task." : null,
        }));
      });
      src.addEventListener("completed", () => setRun((r) => ({ ...r, status: r.status === "running" && r.text ? "done" : r.status })));
      src.addEventListener("failed", () => setRun((r) => ({ ...r, status: "error", error: "The GPU could not finish this task." })));
      // No events stream (some tunnels drop SSE): read the order itself until it finishes.
      let polling = false;
      const poll = async () => {
        for (let i = 0; i < 120 && my === runId.current; i++) {
          const o = await getOrder(order.orderId).catch(() => null);
          if (o && my === runId.current) {
            const done = ["completed", "settled", "failed"].includes(o.status);
            const text = o.output?.[0] ?? "";
            setRun((r) => ({
              ...r,
              text: text.length > r.text.length ? text : r.text,
              gpus: o.segments?.length ? [...new Set(o.segments.map((x) => x.label))] : r.gpus,
              providers: o.segments?.length ? [...new Set(o.segments.map((x) => x.provider))] : r.providers,
              tokens: o.progress?.unit === "tokens" ? Math.round(o.progress.done) : r.tokens,
              refund: o.refund && Number(o.refund.amountUsdc) > 0 ? o.refund.amountUsdc : r.refund,
              status: done ? (o.status !== "failed" && text ? "done" : "error") : r.status,
              error: done && (o.status === "failed" || !text) ? "The GPU could not finish this task." : r.error,
            }));
            if (done) return;
          }
          await new Promise((res) => setTimeout(res, 1000));
        }
      };
      src.onerror = () => {
        if (polling) return;
        polling = true;
        src.close();
        void poll();
      };
    } catch (e) {
      void refresh();
      if (my === runId.current) setRun({ ...IDLE, status: "error", error: (e as Error).message });
    }
  }

  const gpuText = (id: string) => {
    const g = gpus[id];
    if (!g) return id.toUpperCase();
    const hw = g.hw?.replace(/\s*\(.*\)$/, "");
    return `${g.label ?? id.toUpperCase()}${hw ? ` · ${hw}` : ""}`;
  };
  const provider = (id: string) => {
    const p = (gpus[id] as any)?.provider;
    return p ? String(p) : null;
  };

  return (
    <main className="models wrap">
      <div className="shead" style={{ marginBottom: 28 }}>
        <h2>Models</h2>
        <p>Open models on Moonshift GPUs, called with the OpenAI client you already use. Pick a priority and the router places every request.</p>
      </div>

      <div className="mdl-table tbl">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>GPU</th>
              {full && <th className="num">VRAM</th>}
              {full && <th className="num">Context</th>}
              <th className="num">Per 1M tokens</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {models === null ? (
              <tr>
                <td colSpan={full ? 6 : 4} className="mdl-empty">
                  {failed ? "The model list is not available right now." : "Loading models..."}
                </td>
              </tr>
            ) : models.length === 0 ? (
              <tr>
                <td colSpan={full ? 6 : 4} className="mdl-empty">
                  No model is serving right now. A model appears here once its GPU passes its health check.
                </td>
              </tr>
            ) : (
              models.map((m) => (
                <tr
                  key={m.gpuId + m.modelId}
                  className={current?.gpuId === m.gpuId && current.modelId === m.modelId ? "on" : undefined}
                  onClick={m.acceptsRequests ? () => setSelected(`${m.gpuId}:${m.modelId}`) : undefined}
                  style={{ cursor: m.acceptsRequests ? "pointer" : "default" }}
                >
                  <td>
                    <b>{m.name}</b>
                    <span className="mdl-id">{m.modelId}</span>
                    <span className="mdl-id mdl-mobile-gpu">{gpuText(m.gpuId)}</span>
                  </td>
                  <td>
                    {gpuText(m.gpuId)}
                    {provider(m.gpuId) && <span className="mdl-id">{provider(m.gpuId)}</span>}
                  </td>
                  {full && <td className="num">{m.vramGb !== null ? `${fmt(m.vramGb, 0)} GB` : ""}</td>}
                  {full && <td className="num">{m.contextLength !== null ? `${fmt(m.contextLength, 0)} tokens` : ""}</td>}
                  <td className="num">{m.pricePer1MTokens !== null ? `${fmt(Number(m.pricePer1MTokens), 2)} ${m.currency}` : m.acceptsRequests ? "Priced per task" : "Quoted on request"}</td>
                  <td className={m.acceptsRequests ? "mdl-serving" : "mdl-req"}>{m.acceptsRequests ? "Serving" : "On request"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mdl-grid">
        <div>
          <div className="mdl-row">
            <span className="lbl" style={{ margin: 0 }}>
              Call it
            </span>
            <Segmented options={MODES} value={priority} onChange={setPriority} />
          </div>
          <Code lang="Python" text={sample(current?.modelId ?? "Qwen/Qwen2.5-1.5B-Instruct", priority, current?.gpuId)} />
          <p className="note">
            Base URL <code className="mdl-inline">{BASE}</code>. The response&apos;s <code className="mdl-inline">x_ms</code> field names the GPUs that
            served it, any move between them, and the payment. Requests require a funded, signed-in session.
          </p>
        </div>

        <div className="trade card mdl-try">
          <div className="mdl-row">
            <label className="lbl" htmlFor="mdl-prompt" style={{ margin: 0 }}>
              Try it
            </label>
            <span className="mdl-id">{current?.acceptsRequests ? current.modelId : "No serving model"}</span>
          </div>
          <textarea id="mdl-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="mdl-row">
            <span className="note" style={{ margin: 0 }}>
              {!wallet ? "Connect your wallet to run a model." : !balanceFresh ? "Checking your USDC balance." : !funded ? "Add USDC to your account to run a model." : !current ? "No model is serving right now. The list refreshes automatically." : "Paid from your account, streamed as the GPU writes."}
            </span>
            <button
              type="button"
              className="btn ink sm"
              style={!funded || run.status === "running" || !current?.acceptsRequests || !prompt.trim() ? { background: "transparent", color: "var(--ink2)", border: "1px solid var(--rule)", opacity: 1 } : undefined}
              disabled={!funded || run.status === "running" || !current?.acceptsRequests || !prompt.trim()}
              onClick={tryIt}
            >
              {run.status === "running" ? "Running..." : "Run"}
            </button>
          </div>
          <div className={run.status === "idle" ? "mdl-out idle" : "mdl-out"} aria-live="polite">
            {run.text || (run.status === "running" ? "Waiting for the first token..." : run.error ?? "The answer appears here.")}
          </div>
          {run.moved && <p className="note">{run.moved}</p>}
          {(run.gpus.length > 0 || run.price) && (
            <div className="mdl-meta">
              {run.gpus.length > 0 && (
                <span>
                  {run.gpus.join(", ")}
                  {run.providers.length > 0 ? ` on ${run.providers.map(providerName).join(", ")}` : ""}
                </span>
              )}
              {run.tokens !== null && <span>{fmt(run.tokens, 0)} tokens</span>}
              {run.price && <span>{taskUsdc(run.price)} USDC</span>}
              {run.refund && <span>Refunded {taskUsdc(run.refund)} USDC</span>}
              {run.payment && txUrl("devnet", run.payment) && (
                <a className="txl" href={txUrl("devnet", run.payment)!} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

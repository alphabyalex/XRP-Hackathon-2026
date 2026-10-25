"use client";
// /models: the model catalog (GET /models), a copyable OpenAI client sample
// and a live Try it box. Signed in, Try it places a real order and streams its
// token events; signed out, it calls /v1/chat/completions and shows the answer
// when it returns. No text is revealed that the GPU has not written.
import { useEffect, useRef, useState } from "react";
import type { ApiGpuSummary } from "@moonshift/shared";
import { apiFetch, getGpus } from "@/lib/api";
import { fmt, taskUsdc } from "@/lib/format";
import { chatRouted, createOrder, MODES, orderEventsUrl, providerName, type Mode } from "@/lib/routerApi";
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
  }));
}

function sample(modelId: string, priority: Mode) {
  return `from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",
    api_key="unused",
)

r = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "Explain VWAP in one line"}],
    extra_body={"priority": "${priority}"},  # cheapest | balanced | fastest
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
  const { wallet } = useWallet();

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
  const current = models?.find((m) => m.modelId === selected) ?? serving[0] ?? models?.[0] ?? null;

  async function tryIt() {
    if (!current || run.status === "running" || !prompt.trim()) return;
    const my = ++runId.current;
    es.current?.close();
    setRun({ ...IDLE, status: "running" });
    const messages = [{ role: "user", content: prompt.trim() }];
    if (!wallet) {
      // Signed out: the developer account pays; the answer arrives whole.
      try {
        const r = await chatRouted(prompt.trim(), priority);
        if (my !== runId.current) return;
        setRun({
          ...IDLE,
          status: "done",
          text: r.choices[0]?.message.content ?? "",
          gpus: r.x_ms.gpus,
          providers: r.x_ms.providers,
          price: r.x_ms.price_usdc,
          tokens: r.usage.completion_tokens,
          payment: (r.x_ms as any).payment ?? null,
        });
      } catch (e) {
        if (my === runId.current) setRun({ ...IDLE, status: "error", error: (e as Error).message });
      }
      return;
    }
    try {
      const order = await createOrder({ kind: "inference", mode: priority, maxTokens: 160, requests: [messages] });
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
      src.onerror = () => {
        if (src.readyState === EventSource.CLOSED) setRun((r) => (r.status === "running" ? { ...r, status: r.text ? "done" : "error", error: r.text ? null : "The stream closed." } : r));
      };
    } catch (e) {
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
                  className={current?.modelId === m.modelId ? "on" : undefined}
                  onClick={() => setSelected(m.modelId)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <b>{m.name}</b>
                    <span className="mdl-id">{m.modelId}</span>
                  </td>
                  <td>
                    {gpuText(m.gpuId)}
                    {provider(m.gpuId) && <span className="mdl-id">{provider(m.gpuId)}</span>}
                  </td>
                  {full && <td className="num">{m.vramGb !== null ? `${fmt(m.vramGb, 0)} GB` : ""}</td>}
                  {full && <td className="num">{m.contextLength !== null ? `${fmt(m.contextLength, 0)} tokens` : ""}</td>}
                  <td className="num">{m.pricePer1MTokens !== null ? `${taskUsdc(m.pricePer1MTokens)} USDC` : "Priced per task"}</td>
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
          <Code lang="Python" text={sample(current?.modelId ?? "Qwen/Qwen2.5-1.5B-Instruct", priority)} />
          <p className="note">
            Base URL <code className="mdl-inline">{BASE}</code>. The response&apos;s <code className="mdl-inline">x_ms</code> field names the GPUs that
            served it, any move between them, and the payment.
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
              {wallet ? "Paid from your account, streamed as the GPU writes." : "Connect a wallet to stream the answer token by token."}
            </span>
            <button
              type="button"
              className="btn ink sm"
              disabled={run.status === "running" || !current?.acceptsRequests || !prompt.trim()}
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

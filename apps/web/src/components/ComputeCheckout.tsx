"use client";
import { useEffect, useState } from "react";
import { Segmented } from "./Segmented";
import { RouteOptions } from "./RouteOptions";
import { OrderStatus } from "./OrderStatus";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { fmt, taskUsdc, typedAmount } from "@/lib/format";
import { createOrder, quote as getQuote, type Mode, type Order, type Quote } from "@/lib/routerApi";
import { DEFAULT_TASK_TOKENS, taskRequest, taskTokenLimit, type TaskDraft } from "@/lib/taskRequest";
import { useModels } from "@/lib/catalog";
import { useWallet } from "@/lib/wallet";
import { ConnectPrompt } from "./ConnectPrompt";

type Buffer = "10" | "25" | "50";
export function ComputeCheckout({ task, gpuId, onMode }: { task?: TaskDraft; gpuId?: string; onMode?: (m: Mode) => void } = {}) {
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState("");
  const { data: models } = useModels(task?.gpuId ?? gpuId ?? "gpu-a");
  const serving = (models?.models ?? []).filter(model => model.status === "serving" && model.acceptsRequests && (!gpuId || model.gpuId === gpuId));
  const selected = serving.find(model => model.modelId === modelId) ?? serving[0];
  const draft: TaskDraft = task ?? { type: "inference", description, gpuId: selected?.gpuId ?? gpuId ?? "", modelId: selected?.modelId ?? "", contextLength: selected?.contextLength ?? undefined };
  const [size, setSize] = useState(String(DEFAULT_TASK_TOKENS));
  const [deadline, setDeadline] = useState("");
  const [mode, setModeState] = useState<Mode>("balanced");
  const setMode = (value: Mode) => { setModeState(value); onMode?.(value); };
  const [buffer, setBuffer] = useState<Buffer>("25");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const { wallet } = useWallet();
  const toast = useToast();
  const n = Number(size), maxTokens = taskTokenLimit(draft.description, draft.contextLength);
  const tooBig = !Number.isInteger(n) || n < 1 || n > maxTokens;
  useEffect(() => {
    let live = true;
    setQuote(null); setQuoteErr(null);
    let request;
    try { request = taskRequest({ type: draft.type, description: draft.description, gpuId: draft.gpuId, modelId: draft.modelId, contextLength: draft.contextLength }, n, deadline); }
    catch (error) { setQuoteErr((error as Error).message); return; }
    const load = () => getQuote({ ...request, requests: 1 }).then(result => { if (live) { setQuote(result); setQuoteErr(null); } }).catch(error => { if (live) { setQuote(null); setQuoteErr(error.message); } });
    const timer = setTimeout(load, 300), refresh = setInterval(load, 5000);
    return () => { live = false; clearTimeout(timer); clearInterval(refresh); };
  }, [draft.type, draft.description, draft.gpuId, draft.modelId, draft.contextLength, n, deadline]);
  const plan = quote?.options[mode], estimate = Number(plan?.priceUsdc ?? 0), cap = estimate * (1 + Number(buffer) / 100);
  async function submit() {
    if (busy || !plan?.feasible || tooBig || draft.type !== "inference") return;
    setBusy(true);
    try { setOrder(await createOrder({ ...taskRequest(draft, n, deadline), mode, bufferPct: Number(buffer) as 10 | 25 | 50 })); }
    catch (error) { toast("Task not submitted", (error as Error).message); }
    finally { setBusy(false); }
  }
  if (order) return <div><OrderStatus initial={order}/><Button variant="ghost" onClick={() => setOrder(null)}>New task</Button></div>;
  if (draft.type !== "inference") return <p className="note">This endpoint runs text inference. Fine-tuning, rendering and other workloads cannot be submitted here. <a href="/docs">Read Docs</a>.</p>;
  return <div>
    {!task && <>
      <label className="lbl" htmlFor="checkout-description">Describe your task</label>
      <textarea id="checkout-description" rows={3} value={description} onChange={event => setDescription(event.target.value)} />
      <label className="lbl" htmlFor="checkout-model">Model</label>
      <div className="inp"><select id="checkout-model" value={selected?.modelId ?? ""} onChange={event => setModelId(event.target.value)} disabled={!serving.length}>
        {serving.length ? serving.map(model => <option key={`${model.gpuId}:${model.modelId}`} value={model.modelId}>{model.gpuId.toUpperCase()}: {model.name}</option>) : <option value="">No model is serving right now</option>}
      </select></div>
    </>}
    <label className="lbl" htmlFor="task-size">Maximum output tokens</label>
    <div className="inp"><input id="task-size" type="text" inputMode="numeric" autoComplete="off" value={size} onChange={event => setSize(typedAmount(event.target.value, false))}/></div>
    <p className="note">Up to {fmt(maxTokens, 0)} output tokens with this description. One request runs on the selected GPU.</p>
    <label className="lbl task-deadline" htmlFor="task-deadline">Deadline (optional)</label>
    <div className="inp"><input id="task-deadline" type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)}/></div>
    <RouteOptions quote={quote} value={mode} onChange={setMode}/>
    <span className="lbl">Price cap</span>
    <Segmented options={[{value:"10",label:"+10%"},{value:"25",label:"+25%"},{value:"50",label:"+50%"}]} value={buffer} onChange={setBuffer}/>
    <p className="note cap-line">{plan?.feasible ? <><span>Estimate {taskUsdc(estimate)} USDC</span> · <span>You pay at most {taskUsdc(cap)} USDC</span></> : quoteErr ?? "Pricing your task"}</p>
    {wallet ? <Button disabled={busy || !plan?.feasible || tooBig} onClick={submit}>{busy ? "Submitting..." : plan?.feasible ? `Submit task, up to ${taskUsdc(cap)} USDC` : "Submit task"}</Button> : <ConnectPrompt/>}
  </div>;
}

"use client";
import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { chatRouted, MODES, type Mode, type Move } from "@/lib/routerApi";
import { usePolled } from "@/lib/liveData";
import type { CatalogModel } from "@/lib/catalog";
import { useWallet } from "@/lib/wallet";
import { Segmented } from "./Segmented";
import "./PlaygroundTry.css";

// These are starting questions only. Every answer comes from a verified serving endpoint.
const QUESTIONS = [
  "What does a GPU do?",
  "Why are GPUs useful for AI?",
  "What is a good name for a coffee shop on the moon?",
  "What does it mean to own a share of an asset?",
  "How do you describe a server that never sleeps?",
  "How does a line of credit differ from a loan?",
];
const PAUSE_MS = 8000;
type Endpoint = Pick<CatalogModel, "gpuId" | "modelId" | "name">;
type Meta = { model: string; gpuId: string; gpus: string[]; tokens: number | null; price: string | null; moves: Move[]; orderId: string };
type Answer = { question: string; text: string; meta: Meta; nextQuestion: string | null; servedAt: number };
const gpuIdOf = (label: string) => label.toLowerCase().replace(/\s+/g, "-");
const cacheKey = (q: string, p: Mode, gpu: Endpoint) => `ms-ask:v2:${gpu.gpuId}:${gpu.modelId}:${p}:${q}`;

function readCache(q: string, p: Mode, gpu: Endpoint): Answer | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(q, p, gpu));
    const answer: Answer | null = raw ? JSON.parse(raw) : null;
    return answer?.question === q && typeof answer.text === "string" && answer.text && answer.meta?.orderId && answer.meta.model === gpu.modelId
      && answer.meta.gpuId === gpu.gpuId && Array.isArray(answer.meta.moves) && Array.isArray(answer.meta.gpus)
      && answer.meta.gpus.every(label => typeof label === "string") && answer.meta.gpus.some(label => gpuIdOf(label) === gpu.gpuId) ? answer : null;
  } catch { return null; }
}
function writeCache(q: string, p: Mode, gpu: Endpoint, answer: Answer) {
  try { sessionStorage.setItem(cacheKey(q, p, gpu), JSON.stringify(answer)); } catch { /* Session storage is optional. */ }
}
function recentAnswers(gpus: Endpoint[], priority: Mode): Answer[] {
  try {
    const answers: Answer[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith("ms-ask:v2:")) continue;
      try {
        const candidate = JSON.parse(sessionStorage.getItem(key) ?? "null");
        const gpu = gpus.find(item => item.gpuId === candidate?.meta?.gpuId && item.modelId === candidate?.meta?.model);
        if (!gpu || typeof candidate?.question !== "string" || key !== cacheKey(candidate.question, priority, gpu)) continue;
        const answer = readCache(candidate.question, priority, gpu);
        if (answer) answers.push(answer);
      } catch { /* Ignore incomplete cache entries. */ }
    }
    return answers.sort((a, b) => b.servedAt - a.servedAt);
  } catch { return []; }
}

function generatedReply(raw: string): { text: string; nextQuestion: string | null } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const data = JSON.parse(cleaned);
    if (typeof data.answer === "string" && data.answer.trim()) {
      const next = typeof data.next_question === "string" ? data.next_question.trim() : "";
      return { text: data.answer.trim(), nextQuestion: next.length >= 8 && next.length <= 180 && /\?$/.test(next) && !/[\n<>]/.test(next) ? next : null };
    }
  } catch { /* An endpoint can answer in plain text instead of the requested format. */ }
  // A token cap can cut off the next question after a complete, valid answer string.
  const answerField = /"answer"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(cleaned);
  if (answerField) {
    try { return { text: JSON.parse(answerField[1]), nextQuestion: null }; } catch { /* Show the actual returned text. */ }
  }
  return { text: raw.trim(), nextQuestion: null };
}
const automaticPrompt = (question: string) =>
  `Answer the following question in one short sentence. Then suggest a different short question about practical AI, GPUs, finance basics, or space. Return only JSON with two string fields: "answer" and "next_question". End the new question with a question mark. Question: ${question}`;

export function PlaygroundTry({ autoplay = false }: { autoplay?: boolean }) {
  const [prompt, setPrompt] = useState(QUESTIONS[0]);
  const [priority, setPriority] = useState<Mode>("balanced");
  const [out, setOut] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [target, setTarget] = useState<Endpoint | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [cached, setCached] = useState(false);
  const [auto, setAuto] = useState(autoplay);
  const [visible, setVisible] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const [step, setStep] = useState(0);
  const wallet = useWallet();
  const account = wallet.account as (NonNullable<typeof wallet.account> & { balance?: string | null; balanceUpdatedAt?: string | null }) | null;
  const balance = account?.balance === null || account?.balance === undefined ? null : Number(account.balance);
  const balanceAge = account?.balanceUpdatedAt ? Date.now() - Date.parse(account.balanceUpdatedAt) : Infinity;
  const balanceFresh = Number.isFinite(balanceAge) && balanceAge >= -5000 && balanceAge <= 15000;
  const canSpend = wallet.loaded && wallet.wallet?.verified === true && balanceFresh && balance !== null && Number.isFinite(balance) && balance > 0;
  const models = usePolled<{ models: CatalogModel[] }>("/models", { ms: 5000, on: ["task", "usage"] });
  const serving = models.error ? [] : (models.data?.models ?? []).filter(model => model.status === "serving" && model.acceptsRequests && model.gpuId && model.modelId);
  const servingKey = serving.map(model => `${model.gpuId}:${model.modelId}`).join(",");
  const runId = useRef(0);
  const gpuIndex = useRef(0);
  const startedAt = useRef(0);
  const nextQuestion = useRef<string | null>(null);
  const asked = useRef(new Set<string>());
  const ref = useRef<HTMLDivElement>(null);
  const available = serving.find(model => model.gpuId === target?.gpuId && model.modelId === target.modelId) ?? serving[0] ?? null;
  const displayModel = meta?.model ?? target?.modelId ?? available?.modelId;
  const displayGpu = meta?.gpuId ?? target?.gpuId ?? available?.gpuId;

  useEffect(() => () => { runId.current++; }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { threshold: 0.12 });
    if (ref.current) observer.observe(ref.current);
    const visibility = () => setTabVisible(document.visibilityState === "visible");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  function finish(answer: Answer, fromCache: boolean) {
    setOut(answer.text);
    setMeta(answer.meta);
    setCached(fromCache);
    nextQuestion.current = answer.nextQuestion && !asked.current.has(answer.nextQuestion) ? answer.nextQuestion : null;
    setRunning(false);
  }

  async function run(question: string, p: Mode, fromAuto: boolean, gpu: Endpoint) {
    if (!canSpend || !account?.balanceUpdatedAt || Date.now() - Date.parse(account.balanceUpdatedAt) > 15000) return;
    const my = ++runId.current;
    asked.current.add(question);
    startedAt.current = Date.now();
    setTarget(gpu);
    setRunning(true);
    setElapsed(0);
    setOut("");
    setError(null);
    setMeta(null);
    setCached(false);
    const previous = fromAuto ? readCache(question, p, gpu) : null;
    if (previous) return finish(previous, true);
    try {
      const res = await chatRouted(fromAuto ? automaticPrompt(question) : `${question}\nKeep the answer brief.`, p, gpu.gpuId, gpu.modelId, fromAuto ? 96 : 128);
      if (my !== runId.current) return;
      const text = res.choices[0]?.message.content?.trim();
      if (!text || res.model !== gpu.modelId || !res.x_ms.gpus.some(label => gpuIdOf(label) === gpu.gpuId)) {
        throw new Error("The response could not be verified.");
      }
      const reply = fromAuto ? generatedReply(text) : { text, nextQuestion: null };
      const answer: Answer = {
        question, text: reply.text, nextQuestion: reply.nextQuestion, servedAt: Date.now(),
        meta: { model: res.model, gpuId: gpu.gpuId, gpus: res.x_ms.gpus,
          tokens: Number.isFinite(res.usage.completion_tokens) ? res.usage.completion_tokens : null,
          price: res.x_ms.price_usdc !== null && Number.isFinite(Number(res.x_ms.price_usdc)) ? res.x_ms.price_usdc : null,
          moves: res.x_ms.moves ?? [], orderId: res.x_ms.order_id },
      };
      if (fromAuto) writeCache(question, p, gpu, answer);
      finish(answer, false);
      void wallet.refresh();
    } catch {
      if (my !== runId.current) return;
      setError("That request could not finish. Try another question.");
      setRunning(false);
      void wallet.refresh();
    }
  }

  useEffect(() => {
    if (!auto || !visible || !tabVisible || running || !serving.length) return;
    const previous = canSpend ? [] : recentAnswers(serving, priority);
    if (!canSpend && !previous.length) return;
    const timer = setTimeout(() => {
      if (!canSpend) {
        const answer = previous[step % previous.length];
        const gpu = serving.find(item => item.gpuId === answer.meta.gpuId && item.modelId === answer.meta.model)!;
        setTarget(gpu);
        setPrompt(answer.question);
        setStep(value => value + 1);
        finish(answer, true);
        return;
      }
      const question = nextQuestion.current ?? QUESTIONS[step % QUESTIONS.length];
      nextQuestion.current = null;
      const gpu = serving[gpuIndex.current++ % serving.length];
      setPrompt(question);
      setStep(value => value + 1);
      void run(question, priority, true, gpu);
    }, step === 0 ? 600 : PAUSE_MS);
    return () => clearTimeout(timer);
    // Only a changed serving fleet should reset this timer, not each catalog refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, visible, tabVisible, running, step, priority, servingKey, canSpend]);

  return (
    <div className="try" ref={ref} aria-busy={running}>
      <div className="row playground-heading">
        <label className="lbl" htmlFor="prompt" style={{ margin: 0 }}>{cached ? "Recent response" : auto && canSpend ? "Asked live" : "Try it"}</label>
        <span className="playground-model">{displayGpu && <b>{displayGpu.toUpperCase()}</b>} {displayModel?.split("/").at(-1) ?? "Checking available models"}</span>
      </div>
      <textarea id="prompt" rows={2} value={prompt} readOnly={running}
        onFocus={() => setAuto(false)}
        onChange={event => { setAuto(false); setPrompt(event.target.value); setOut(""); setMeta(null); setError(null); }} />
      <div style={{ marginTop: 12 }}><Segmented options={MODES} value={priority} onChange={setPriority} /></div>
      <div className="row playground-controls">
        <span className="playground-progress">{running ? `Waiting for ${target?.gpuId.toUpperCase()}. ${elapsed}s elapsed.` : !serving.length ? "Checking available GPUs" : ""}</span>
        {!wallet.loaded ? <button className="btn ink sm" disabled>Checking wallet</button> : !wallet.wallet ?
          <button type="button" className="btn ink sm" disabled={wallet.busy} onClick={() => void wallet.connect().catch(() => {})}>Connect wallet</button> :
          !balanceFresh || balance === null ? <button className="btn ink sm" disabled>Checking balance</button> : !canSpend ?
          <a href="/portfolio" className="btn ink sm">Add USDC</a> : <button type="button" className="btn ink sm" disabled={running || !available || !prompt.trim()}
          onClick={() => { setAuto(false); if (available) void run(prompt.trim(), priority, false, available); }}>
          {running ? "Running" : "Run"} <span className="arrow" aria-hidden="true">&rarr;</span>
        </button>}
      </div>
      <div className="out" aria-live="polite">{out || <span className="ph">{error ?? (running ? "The answer appears when the GPU finishes." : "The answer appears here.")}</span>}</div>
      {meta && <div className="meta">
        <span>Served by <b>{meta.gpus.join(", ")}</b></span>
        {meta.tokens !== null && <span><b>{meta.tokens}</b> tokens</span>}
        {meta.price !== null && <span><b>{fmt(Number(meta.price), 6)}</b> USDC</span>}
        {meta.moves.map(move => <span key={move.at}>Moved to {move.toLabel}, resumed</span>)}
      </div>}
    </div>
  );
}

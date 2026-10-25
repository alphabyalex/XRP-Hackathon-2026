"use client";
// "Describe your task": POST /tasks/estimate sizes it (Bedrock when it answers, a fixed rule when
// it doesn't), the sliders ease to that size, and POST /tasks/quote prices the hardware live.
// The parent gets the size, so the router checkout below charges for the same task.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useTween } from "./charts";
import { estimateTask, quoteTask } from "@/lib/api";
import { num, useModels, type CatalogGpu, type Sizing, type TaskQuote } from "@/lib/catalog";
import { fmt } from "@/lib/format";
import { fmtEta, type Mode, type TaskType } from "@/lib/routerApi";

export type TaskSize = Omit<Sizing, "model">;

// The serving endpoint runs text inference only (other types answer TASK_TYPE_UNAVAILABLE), so
// only inference is offered here; planned types live on Docs.
const TYPES: { value: TaskType; label: string }[] = [{ value: "inference", label: "Text inference" }];

function Slider({
  id,
  label,
  value,
  shown,
  animating,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  shown: number;
  animating: boolean;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  // While a new estimate eases in, show the tweened value; while dragging, follow the hand.
  const v = animating ? shown : value;
  return (
    <div className="slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <b className="live-num">
          {fmt(Math.round(v / step) * step, step < 1 ? 1 : 0)} {unit}
        </b>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, v))} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function TaskDescribe({
  gpu,
  type,
  onType,
  mode,
  onSize,
}: {
  gpu: CatalogGpu | undefined;
  type: TaskType;
  onType: (t: TaskType) => void;
  mode: Mode;
  onSize: (s: TaskSize) => void;
}) {
  const maxVcpu = num(gpu?.vcpu) ?? 4;
  const maxRam = num(gpu?.ramGb) ?? 16;
  const maxDisk = num(gpu?.storageGb) ?? 50;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [size, setSize] = useState<TaskSize>({ gpus: 1, vcpu: 2, ramGb: 4, storageGb: 10, durationSeconds: 3600 });
  const [quote, setQuote] = useState<TaskQuote | null>(null);
  const [animating, setAnimating] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [vcpu, ram, disk, mins] = useTween([size.vcpu, size.ramGb, size.storageGb, size.durationSeconds / 60], 700);
  const { data: models } = useModels(gpu?.id ?? "gpu-a");
  const serving = (models?.models ?? []).filter((m) => m.status === "serving" && m.acceptsRequests);
  const [model, setModel] = useState("");
  useEffect(() => {
    if (!model && serving[0]) setModel(serving[0].modelId);
  }, [model, serving]);

  useEffect(() => onSize(size), [size, onSize]);

  // Live hardware quote: on every change, then every 5 seconds while the rates move.
  useEffect(() => {
    if (!gpu) return;
    let live = true;
    const load = () =>
      quoteTask({ gpuId: gpu.id, mode, ...size })
        .then((q) => {
          if (!live) return;
          setQuote(q);
          setQuoteErr(null);
        })
        .catch((e) => live && (setQuote(null), setQuoteErr((e as Error).message)));
    const t0 = setTimeout(load, 300);
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [gpu, mode, size]);

  async function estimate() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const e = await estimateTask(text.trim(), type);
      const s = e.sizing;
      setSize({
        gpus: Math.max(1, s.gpus),
        vcpu: Math.min(maxVcpu, Math.max(1, s.vcpu)),
        ramGb: Math.min(maxRam, Math.max(1, s.ramGb)),
        storageGb: Math.min(maxDisk, Math.max(1, s.storageGb)),
        durationSeconds: Math.max(60, s.durationSeconds),
      });
      setAnimating(true);
      setTimeout(() => setAnimating(false), 750);
      if (s.model && serving.some((m) => m.modelId === s.model)) setModel(s.model);
      setNote(e.source === "bedrock" ? "Sized by Amazon Bedrock from your description." : "Sized from your description with our standard rule.");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof TaskSize) => (v: number) => setSize((s) => ({ ...s, [k]: k === "durationSeconds" ? v * 60 : v }));
  const opt = quote?.options.find((o) => o.mode === mode);

  return (
    <div className="task-describe">
      <label className="lbl" htmlFor="task-desc">
        Describe your task
      </label>
      <textarea
        id="task-desc"
        rows={3}
        value={text}
        placeholder="Summarize 2,000 support tickets and tag each one by topic"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) estimate();
        }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <span className="note" style={{ margin: 0 }}>
          {note ?? " "}
        </span>
        <button type="button" className="btn ghost sm" style={{ width: "auto", flex: "none" }} disabled={!text.trim() || busy} onClick={estimate}>
          {busy ? "Sizing..." : "Size it"}
        </button>
      </div>

      <span className="lbl">Task type</span>
      <div className="task-types" role="radiogroup" aria-label="Task type">
        {TYPES.map((t) => (
          <button key={t.value} type="button" role="radio" aria-checked={type === t.value} className={clsx(type === t.value && "on")} onClick={() => onType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="sliders">
        <Slider id="sz-vcpu" label="vCPU" value={size.vcpu} shown={vcpu} animating={animating} min={1} max={maxVcpu} step={1} unit="" onChange={set("vcpu")} />
        <Slider id="sz-ram" label="RAM" value={size.ramGb} shown={ram} animating={animating} min={1} max={maxRam} step={1} unit="GB" onChange={set("ramGb")} />
        <Slider id="sz-disk" label="Storage" value={size.storageGb} shown={disk} animating={animating} min={1} max={maxDisk} step={1} unit="GB" onChange={set("storageGb")} />
        <Slider id="sz-time" label="Run time" value={size.durationSeconds / 60} shown={mins} animating={animating} min={5} max={1440} step={5} unit="min" onChange={set("durationSeconds")} />
      </div>

      <label className="lbl" htmlFor="task-model">
        Model
      </label>
      <div className="inp">
        <select id="task-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!serving.length}>
          {serving.length ? (
            serving.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.name}
                {num(m.contextLength) ? `, ${fmt(Number(m.contextLength), 0)} token context` : ""}
              </option>
            ))
          ) : (
            <option value="">{models ? "No model is serving right now" : "Loading models"}</option>
          )}
        </select>
      </div>

      <div className="line" style={{ marginTop: 16 }}>
        <span>Hardware for this task</span>
        <b>{opt ? `$${fmt(Number(opt.totalPrice), 4)}` : quoteErr ? "Not available" : "Pricing"}</b>
      </div>
      {opt && (
        <p className="note" style={{ marginTop: 4 }}>
          ${fmt(Number(opt.pricePerHour), 3)} an hour, about {fmtEta(opt.estimatedDurationSeconds)}. Rates as of {new Date(opt.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.
        </p>
      )}
      {!opt && quoteErr && <p className="note">{quoteErr}</p>}
    </div>
  );
}

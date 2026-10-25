"use client";
// Submit a task, not a time slot: what it is, how big, an optional deadline,
// and Cheapest / Balanced / Fastest with the router's real price and ETA for
// the whole job. The router decides which GPU and when. The buyer sets a price
// cap (estimate plus a buffer) that is set aside on the ledger; the task is
// charged its actual cost and the rest comes back.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Segmented } from "./Segmented";
import { RouteOptions } from "./RouteOptions";
import { OrderStatus } from "./OrderStatus";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { fmt, taskUsdc, typedAmount } from "@/lib/format";
import { createOrder, quote as getQuote, type Mode, type Order, type OrderRequest, type Quote, type TaskType } from "@/lib/routerApi";
import { useWallet } from "@/lib/wallet";
import { ConnectPrompt } from "./ConnectPrompt";

type Buffer = "10" | "25" | "50";

const TYPES: { value: TaskType; label: string }[] = [
  { value: "inference", label: "Inference" },
  { value: "fine-tune", label: "Fine-tune" },
  { value: "render", label: "Render" },
  { value: "other", label: "Other" },
];

// One request generates at most 8,192 tokens, and a batch is sent as one body,
// so an inference task is at most 400 long reports.
const MAX_TOKENS_PER_REQUEST = 8192;
const MAX_REQUESTS = 400;
const BATCH_TOKENS = MAX_TOKENS_PER_REQUEST * MAX_REQUESTS;

// The router's order shape for a task: an inference batch is sized in tokens,
// everything else in GPU-hours of work.
function taskRequest(type: TaskType, size: number, deadline: string): OrderRequest {
  const left = deadline ? (new Date(deadline).getTime() - Date.now()) / 1000 : 0;
  const deadlineSeconds = left > 60 ? Math.round(left) : undefined;
  if (type === "inference") {
    const tokens = Math.max(1, Math.round(size));
    // Long reports of about 3,000 words (up to 8,192), at least two so Fastest can run both GPUs at once;
    // the default (5,000 tokens) is one per GPU, about 80 s.
    const parts = Math.min(MAX_REQUESTS, Math.max(tokens >= 2 ? 2 : 1, Math.round(tokens / 3000), Math.ceil(tokens / MAX_TOKENS_PER_REQUEST)));
    const maxTokens = Math.ceil(tokens / parts);
    return {
      kind: "inference",
      taskType: type,
      tokens,
      maxTokens,
      requests: Array.from({ length: parts }, (_, i) => [
        { role: "user", content: `Write a detailed report of about ${maxTokens} words on batch item ${i + 1}: GPU utilization and revenue.` },
      ]),
      deadlineSeconds,
    };
  }
  return { kind: "rental", taskType: type, minutes: Math.max(1, Math.round(size * 60)), deadlineSeconds };
}

export function ComputeCheckout() {
  const [type, setType] = useState<TaskType>("inference");
  const [size, setSize] = useState("5000");
  const [deadline, setDeadline] = useState("");
  const [mode, setMode] = useState<Mode>("balanced");
  const [buffer, setBuffer] = useState<Buffer>("25");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [limits, setLimits] = useState<Quote["limits"] | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  // Tasks are paid from the signed-in account; the api decides who pays.
  const { wallet } = useWallet();
  const toast = useToast();
  const n = Number(size) || 0;
  const inference = type === "inference";
  // The largest task: what the fleet finishes in a week (and, for inference, one batch).
  const maxSize = limits ? (inference ? Math.min(limits.maxTokens, BATCH_TOKENS) : limits.maxGpuHours) : null;
  const tooBig = maxSize !== null && n > maxSize;
  const maxText = maxSize === null ? "" : inference ? `Max ${fmt(maxSize, 0)} tokens` : `Max ${fmt(maxSize, 0)} GPU-hours`;

  useEffect(() => {
    setQuoteErr(null);
    if (!(n > 0) || tooBig) return setQuote(null);
    let live = true;
    const req = taskRequest(type, n, deadline);
    // A quote needs only counts, not the batch items themselves.
    const load = () =>
      getQuote({ ...req, requests: Array.isArray(req.requests) ? req.requests.length : req.requests })
        .then((q) => {
          if (!live) return;
          setQuote(q);
          if (q.limits) setLimits(q.limits);
        })
        .catch((e) => {
          if (!live) return;
          setQuote(null);
          setQuoteErr((e as Error).message);
        });
    setQuote(null);
    const t0 = setTimeout(load, 300);
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [type, n, deadline, tooBig]);

  const plan = quote?.options[mode];
  const estimate = Number(plan?.priceUsdc ?? 0);
  const cap = estimate * (1 + Number(buffer) / 100);

  async function submit() {
    if (busy || !plan?.feasible || tooBig) return;
    setBusy(true);
    try {
      setOrder(await createOrder({ ...taskRequest(type, n, deadline), mode, bufferPct: Number(buffer) as 10 | 25 | 50 }));
    } catch (err) {
      toast("Task not submitted", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (order) {
    return (
      <div>
        <OrderStatus initial={order} />
        <Button variant="ghost" onClick={() => setOrder(null)}>
          New task
        </Button>
      </div>
    );
  }

  return (
    <div>
      <span className="lbl">Task</span>
      <div className="task-types" role="radiogroup" aria-label="Task">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={type === t.value}
            className={clsx(type === t.value && "on")}
            onClick={() => {
              setType(t.value);
              setSize(t.value === "inference" ? "5000" : "1");
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className="lbl" htmlFor="task-size">
        Size ({inference ? "tokens" : "GPU-hours"})
      </label>
      <div className="inp">
        <input id="task-size" type="text" autoComplete="off" inputMode="decimal" value={size} onChange={(e) => setSize(typedAmount(e.target.value))} />
      </div>
      {tooBig && <p className="note dn">{maxText}</p>}
      <label className="lbl task-deadline" htmlFor="task-deadline">
        Deadline (optional)
      </label>
      <div className="inp">
        <input id="task-deadline" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </div>
      <RouteOptions quote={quote} value={mode} onChange={setMode} />
      <span className="lbl">Price cap</span>
      <Segmented
        options={[
          { value: "10", label: "+10%" },
          { value: "25", label: "+25%" },
          { value: "50", label: "+50%" },
        ]}
        value={buffer}
        onChange={setBuffer}
      />
      <p className="note cap-line">
        {/* two halves that each stay whole; a narrow panel breaks between them */}
        {plan?.feasible ? (
          <>
            <span>Estimate {taskUsdc(estimate)} USDC</span> · <span>You pay at most {taskUsdc(cap)} USDC</span>
          </>
        ) : tooBig ? (
          maxText
        ) : (
          quoteErr ?? (quote ? "No GPU can take this task right now" : " ")
        )}
      </p>
      {wallet ? (
        <Button disabled={busy || !plan?.feasible || tooBig} onClick={submit}>
          {busy ? "Submitting..." : plan?.feasible && !tooBig ? `Submit task, up to ${taskUsdc(cap)} USDC` : "Submit task"}
        </Button>
      ) : (
        <ConnectPrompt />
      )}
    </div>
  );
}

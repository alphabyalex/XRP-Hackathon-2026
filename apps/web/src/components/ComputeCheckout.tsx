"use client";
// Submit a task, not a time slot: what it is, how big, an optional deadline,
// and Cheapest / Balanced / Fastest with the router's real price and ETA. The
// router decides which GPU and when. The buyer sets a price cap (estimate plus
// a buffer) that is set aside on the ledger; the task is charged its actual
// cost and the rest comes back.
import { useEffect, useState } from "react";
import { Segmented } from "./Segmented";
import { RouteOptions } from "./RouteOptions";
import { OrderStatus } from "./OrderStatus";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { typedAmount, usdc } from "@/lib/format";
import { createOrder, quote as getQuote, type Mode, type Order, type OrderRequest, type Quote, type TaskType } from "@/lib/routerApi";
import { useWallet } from "@/lib/wallet";
import { ConnectPrompt } from "./ConnectPrompt";

type Buffer = "10" | "25" | "50";

const TYPES: { value: TaskType; label: string }[] = [
  { value: "inference", label: "Inference batch" },
  { value: "fine-tune", label: "Fine-tune" },
  { value: "render", label: "Render" },
  { value: "other", label: "Other" },
];

// The router's order shape for a task: an inference batch is sized in tokens,
// everything else in GPU-hours of work.
function taskRequest(type: TaskType, size: number, deadline: string): OrderRequest {
  const left = deadline ? (new Date(deadline).getTime() - Date.now()) / 1000 : 0;
  const deadlineSeconds = left > 60 ? Math.round(left) : undefined;
  if (type === "inference") {
    const tokens = Math.max(1, Math.round(size));
    const parts = Math.min(20, Math.max(1, Math.round(tokens / 2000)));
    const maxTokens = Math.min(8192, Math.ceil(tokens / parts));
    return {
      kind: "inference",
      taskType: type,
      tokens,
      maxTokens,
      requests: Array.from({ length: parts }, (_, i) => [{ role: "user", content: `Batch item ${i + 1}` }]),
      deadlineSeconds,
    };
  }
  return { kind: "rental", taskType: type, minutes: Math.min(1440, Math.max(1, Math.round(size * 60))), deadlineSeconds };
}

export function ComputeCheckout() {
  const [type, setType] = useState<TaskType>("inference");
  const [size, setSize] = useState("50000");
  const [deadline, setDeadline] = useState("");
  const [mode, setMode] = useState<Mode>("balanced");
  const [buffer, setBuffer] = useState<Buffer>("25");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  // Tasks are paid from the signed-in account; the api decides who pays.
  const { wallet } = useWallet();
  const toast = useToast();
  const n = Number(size) || 0;

  useEffect(() => {
    if (!(n > 0)) return setQuote(null);
    let live = true;
    const req = taskRequest(type, n, deadline);
    // A quote needs only counts, not the batch items themselves.
    const load = () =>
      getQuote({ ...req, requests: Array.isArray(req.requests) ? req.requests.length : req.requests })
        .then((q) => live && setQuote(q))
        .catch(() => live && setQuote(null));
    setQuote(null);
    const t0 = setTimeout(load, 300);
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [type, n, deadline]);

  const plan = quote?.options[mode];
  const estimate = Number(plan?.priceUsdc ?? 0);
  const cap = estimate * (1 + Number(buffer) / 100);

  async function submit() {
    if (busy || !plan?.feasible) return;
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
      <Segmented options={TYPES} value={type} onChange={(t) => {
          setType(t);
          setSize(t === "inference" ? "50000" : "1");
        }}
      />
      <div className="two" style={{ marginTop: 14 }}>
        <div>
          <label className="lbl" htmlFor="task-size">
            Size
          </label>
          <div className="inp">
            <input id="task-size" type="text" autoComplete="off" inputMode="decimal" value={size} onChange={(e) => setSize(typedAmount(e.target.value))} />
            <span>{type === "inference" ? "tokens" : "GPU-hours"}</span>
          </div>
        </div>
        <div>
          <label className="lbl" htmlFor="task-deadline">
            Deadline (optional)
          </label>
          <div className="inp">
            <input id="task-deadline" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
        </div>
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
        {plan?.feasible ? `Estimate ${usdc(estimate)} USDC · You pay at most ${usdc(cap)} USDC` : quote ? plan?.reason ?? "No GPU can take this task right now" : " "}
      </p>
      {wallet ? (
        <Button disabled={busy || !plan?.feasible} onClick={submit}>
          {busy ? "Submitting..." : plan?.feasible ? `Submit task, up to ${usdc(cap)} USDC` : "Submit task"}
        </Button>
      ) : (
        <ConnectPrompt />
      )}
    </div>
  );
}

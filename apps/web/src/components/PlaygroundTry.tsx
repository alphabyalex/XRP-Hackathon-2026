"use client";
import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { chatRouted, MODES, type Mode, type Move } from "@/lib/routerApi";
import { Segmented } from "./Segmented";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useReveal } from "@/hooks/useReveal";

// Calls the OpenAI-compatible POST /v1/chat/completions with a routing priority; the order router
// picks the GPU. While the visitor hasn't typed anything, the panel asks GPU-A one question at a
// time and shows its real answer. Answers are cached for the session, so a question is only paid
// for once. The api returns the full answer, so the reveal here is client-side.
const QUESTIONS = [
  "Explain VWAP in one line",
  "What does a GPU do that a CPU can't, in two sentences?",
  "Give me three names for a coffee shop on the moon",
  "Why do people tokenize real assets? One short paragraph.",
  "Write a haiku about a server that never sleeps",
  "What is the difference between a loan and a line of credit?",
];
const PAUSE_MS = 6000;

type Meta = { gpus: string[]; tokens: number; price: string; moves: Move[] };
type Answer = { text: string; meta: Meta };

const cacheKey = (q: string, p: Mode) => `ms-ask:${p}:${q}`;
function readCache(q: string, p: Mode): Answer | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(q, p));
    return raw ? (JSON.parse(raw) as Answer) : null;
  } catch {
    return null;
  }
}
function writeCache(q: string, p: Mode, a: Answer) {
  try {
    sessionStorage.setItem(cacheKey(q, p), JSON.stringify(a));
  } catch {
    // storage unavailable, the next view asks again
  }
}
const servedByGpuA = (gpus: string[]) => gpus.some((g) => g.toLowerCase() === "gpu-a");

export function PlaygroundTry({ autoplay = false }: { autoplay?: boolean }) {
  const [prompt, setPrompt] = useState(QUESTIONS[0]);
  const [priority, setPriority] = useState<Mode>("balanced");
  const [out, setOut] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [running, setRunning] = useState(false);
  // Autoplay runs until the visitor types or presses Run themselves.
  const [auto, setAuto] = useState(autoplay);
  const [nextQ, setNextQ] = useState(0);
  const rm = usePrefersReducedMotion();
  const runId = useRef(0);
  const { ref, inView } = useReveal<HTMLDivElement>();

  function reveal(my: number, a: Answer) {
    const finish = () => {
      setMeta(a.meta);
      setRunning(false);
    };
    if (rm) {
      setOut(a.text);
      finish();
      return;
    }
    let k = 0;
    const tick = () => {
      if (my !== runId.current) return;
      k += 3;
      setOut(a.text.slice(0, k));
      if (k < a.text.length) setTimeout(tick, 22);
      else finish();
    };
    setTimeout(tick, 150);
  }

  async function run(q: string, p: Mode, fromAuto: boolean) {
    const my = ++runId.current;
    setRunning(true);
    setOut("");
    setMeta(null);
    const cached = fromAuto ? readCache(q, p) : null;
    if (cached) return reveal(my, cached);
    try {
      const res = await chatRouted(q, p);
      if (my !== runId.current) return;
      const a: Answer = {
        text: res.choices[0]?.message.content ?? "",
        meta: { gpus: res.x_ms.gpus, tokens: res.usage.completion_tokens, price: res.x_ms.price_usdc, moves: res.x_ms.moves },
      };
      if (fromAuto) {
        // The showcase only plays answers GPU-A actually served.
        if (!servedByGpuA(a.meta.gpus) || !a.text) {
          setOut("");
          setRunning(false);
          setAuto(false);
          return;
        }
        writeCache(q, p, a);
      }
      reveal(my, a);
    } catch (err) {
      if (my !== runId.current) return;
      setOut(fromAuto ? "GPU-A is not answering right now. Type a question to try again." : (err as Error).message);
      setRunning(false);
      if (fromAuto) setAuto(false);
    }
  }

  // Ask the next question once the panel is on screen and the last answer has had time to read.
  useEffect(() => {
    if (!auto || !inView || running) return;
    const t = setTimeout(
      () => {
        const q = QUESTIONS[nextQ % QUESTIONS.length];
        setPrompt(q);
        setNextQ((n) => n + 1);
        run(q, priority, true);
      },
      nextQ === 0 ? 600 : PAUSE_MS
    );
    return () => clearTimeout(t);
    // run is stable enough for this loop; re-running on its identity would restart the timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, inView, running, nextQ, priority]);

  function stopAuto() {
    if (!auto) return;
    setAuto(false);
    runId.current++;
    setRunning(false);
  }

  return (
    <div className="try" ref={ref}>
      <div className="row">
        <label className="lbl" htmlFor="prompt" style={{ margin: 0 }}>
          {auto ? "Asked live" : "Try it"}
        </label>
        <span className="num" style={{ fontSize: 12, color: "var(--ink3)" }}>
          Qwen2.5 1.5B Instruct
        </span>
      </div>
      <textarea
        id="prompt"
        rows={2}
        value={prompt}
        onFocus={stopAuto}
        onChange={(e) => {
          stopAuto();
          setPrompt(e.target.value);
        }}
      />
      <div style={{ marginTop: 12 }}>
        <Segmented options={MODES} value={priority} onChange={setPriority} />
      </div>
      <div className="row">
        <span />
        <button
          type="button"
          className="btn ink sm"
          disabled={running && !auto}
          onClick={() => {
            stopAuto();
            run(prompt, priority, false);
          }}
        >
          Run{" "}
          <span className="arrow" aria-hidden="true">
            &rarr;
          </span>
        </button>
      </div>
      <div className="out" aria-live="polite">
        {out ? out : <span className="ph">{running ? "Waiting for GPU-A" : "The answer streams here."}</span>}
      </div>
      {meta && (
        <div className="meta">
          <span>
            Served by <b>{meta.gpus.join(", ")}</b>
          </span>
          <span>
            <b>{meta.tokens}</b> tokens
          </span>
          <span>
            <b>{fmt(Number(meta.price), 6)}</b> USDC
          </span>
          {meta.moves.map((m) => (
            <span key={m.at}>Moved to {m.toLabel}, resumed</span>
          ))}
        </div>
      )}
    </div>
  );
}

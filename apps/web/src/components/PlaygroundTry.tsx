"use client";
import { useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { chatRouted, MODES, type Mode, type Move } from "@/lib/routerApi";
import { Segmented } from "./Segmented";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// Ported from .try / #run / #out / #meta in moonshift_v2_source.html. Calls the OpenAI-compatible
// POST /v1/chat/completions with a routing priority; the order router picks the GPU. The api returns
// the full answer, so the reveal here is client-side.
const EXAMPLE_PROMPTS = [
  "Explain VWAP in one line",
  "Calculate GPU arbitrage yield",
  "Summarize XLS-65 lending mechanics",
  "Monte Carlo VaR in Python",
];

export function PlaygroundTry() {
  const [prompt, setPrompt] = useState("Explain VWAP in one line");
  const [priority, setPriority] = useState<Mode>("balanced");
  const [out, setOut] = useState("");
  const [meta, setMeta] = useState<{ gpus: string[]; tokens: number; price: string; moves: Move[] } | null>(null);
  const [running, setRunning] = useState(false);
  const rm = usePrefersReducedMotion();
  const runId = useRef(0);

  async function run() {
    if (running) return;
    const my = ++runId.current;
    setRunning(true);
    setOut("");
    setMeta(null);
    try {
      const res = await chatRouted(prompt, priority);
      if (my !== runId.current) return;
      const text = res.choices[0]?.message.content ?? "";
      const finish = () => {
        setMeta({
          gpus: res.x_ms.gpus,
          tokens: res.usage.completion_tokens,
          price: res.x_ms.price_usdc,
          moves: res.x_ms.moves,
        });
        setRunning(false);
      };
      if (rm) {
        setOut(text);
        finish();
        return;
      }
      let k = 0;
      const tick = () => {
        if (my !== runId.current) return;
        k += 2 + (Math.floor(Math.random() * 4) || 0);
        setOut(text.slice(0, k));
        if (k < text.length) setTimeout(tick, 22);
        else finish();
      };
      setTimeout(tick, 200);
    } catch (err) {
      if (my !== runId.current) return;
      setOut((err as Error).message);
      setRunning(false);
    }
  }

  return (
    <div className="try">
      <div className="row">
        <label className="lbl" htmlFor="prompt" style={{ margin: 0 }}>
          Try it
        </label>
        <span className="num" style={{ fontSize: 12, color: "var(--ink3)" }}>
          Qwen2.5 1.5B Instruct
        </span>
      </div>
      <textarea id="prompt" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPrompt(p)}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 4,
              border: prompt === p ? "1px solid var(--accent)" : "1px solid var(--rule2)",
              background: prompt === p ? "var(--tint)" : "transparent",
              color: prompt === p ? "var(--ink)" : "var(--ink2)",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            {p}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <Segmented options={MODES} value={priority} onChange={setPriority} />
      </div>
      <div className="row">
        <span />
        <button type="button" className="btn ink sm" disabled={running} onClick={run}>
          Run{" "}
          <span className="arrow" aria-hidden="true">
            &rarr;
          </span>
        </button>
      </div>
      <div className="out">{out ? out : <span className="ph">The answer streams here.</span>}</div>
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

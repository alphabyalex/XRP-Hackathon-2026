"use client";
import { useRef, useState } from "react";
import { chat } from "@/lib/api";
import { fmt } from "@/lib/format";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// Ported from .try / #run / #out / #meta in moonshift_v2_source.html. Calls
// the real POST /inference/chat. apps/api returns a full response (no
// token stream), so "streaming" here is a client-side character reveal of
// the real answer, same trick as the reference, no blinking cursor.
export function PlaygroundTry() {
  const [prompt, setPrompt] = useState("Explain VWAP in one line");
  const [out, setOut] = useState("");
  const [meta, setMeta] = useState<{ gpu: string; tokens: number; charge: string; simulated: boolean } | null>(null);
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
      const res = await chat([{ role: "user", content: prompt }]);
      if (my !== runId.current) return;
      const text = res.choices[0]?.message.content ?? "";
      const finish = () => {
        setMeta({
          gpu: res.x_ms.gpu_id.toUpperCase().replace("GPU-", "GPU-"),
          tokens: res.x_ms.output_tokens,
          charge: res.x_ms.charge,
          simulated: res.x_ms.simulated,
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
          Qwen3 1.7B
        </span>
      </div>
      <textarea id="prompt" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
            Served by <b>{meta.gpu}</b>
          </span>
          <span>
            <b>{meta.tokens}</b> tokens
          </span>
          <span>
            +{fmt(Number(meta.charge), 6)} USDC to holders
            
          </span>
        </div>
      )}
    </div>
  );
}

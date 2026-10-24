"use client";
import { useState } from "react";

// Ported from .code / .copy / #copyBtn in moonshift_v2_source.html.
const PLAIN_TEXT = `from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000/v1",
    api_key=os.environ["MOONSHIFT_KEY"],
)

r = client.chat.completions.create(
    model="Qwen/Qwen3-1.7B",
    messages=[{"role": "user",
               "content": "Explain VWAP in one line"}],
)
# served by whichever GPU is on its night shift`;

export function CodeSample() {
  const [label, setLabel] = useState("Copy");

  async function copy() {
    try {
      await navigator.clipboard.writeText(PLAIN_TEXT);
      setLabel("Copied");
      setTimeout(() => setLabel("Copy"), 1500);
    } catch {
      // clipboard unavailable, no-op
    }
  }

  return (
    <div className="code">
      <button type="button" className="copy" onClick={copy}>
        {label}
      </button>
      <pre>
        <span className="k">from</span> openai <span className="k">import</span> OpenAI{"\n\n"}
        client = OpenAI({"\n"}
        {"    "}base_url=<span className="s">&quot;http://localhost:4000/v1&quot;</span>,{"\n"}
        {"    "}api_key=os.environ[<span className="s">&quot;MOONSHIFT_KEY&quot;</span>],{"\n"})
        {"\n\n"}
        r = client.chat.completions.create({"\n"}
        {"    "}model=<span className="s">&quot;Qwen/Qwen3-1.7B&quot;</span>,{"\n"}
        {"    "}messages=[{"{"}
        <span className="s">&quot;role&quot;</span>: <span className="s">&quot;user&quot;</span>,{"\n"}
        {"               "}
        <span className="s">&quot;content&quot;</span>: <span className="s">&quot;Explain VWAP in one line&quot;</span>
        {"}"}],{"\n"})
        {"\n"}
        <span className="c"># served by whichever GPU is on its night shift</span>
      </pre>
    </div>
  );
}

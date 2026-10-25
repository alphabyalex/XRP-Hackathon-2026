"use client";
import { useState } from "react";

// A copyable code block on the dark plate (.code in globals.css). Lines that
// start with # or // are dimmed as comments; nothing else is highlighted.
export function Code({ text, lang, compact }: { text: string; lang?: string; compact?: boolean }) {
  const [label, setLabel] = useState("Copy");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setLabel("Copied");
      setTimeout(() => setLabel("Copy"), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <div className={compact ? "code doc-code compact" : "code doc-code"}>
      {lang && <span className="doc-lang">{lang}</span>}
      <button type="button" className="copy" onClick={copy}>
        {label}
      </button>
      <pre>
        {text.split("\n").map((line, i) => (
          <span key={i} className={/^\s*(#|\/\/)/.test(line) ? "c" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useReveal } from "@/hooks/useReveal";

// The OpenAI client snippet, typed out once when it scrolls into view. Tokens keep their
// highlight class while they type, so the colors never flash in afterwards.
type Tok = [cls: "" | "k" | "s" | "c", text: string];
const tokens = (base: string): Tok[] => [
  ["k", "import"], ["", " os\n"],
  ["k", "from"], ["", " openai "], ["k", "import"], ["", " OpenAI\n\n"],
  ["", "client = OpenAI(\n    base_url="], ["s", `"${base}/v1"`], ["", ",\n    api_key=os.environ["], ["s", '"MOONSHIFT_KEY"'], ["", "],\n)\n\n"],
  ["", "r = client.chat.completions.create(\n    model="], ["s", '"Qwen/Qwen2.5-1.5B-Instruct"'], ["", ",\n    messages=[{"],
  ["s", '"role"'], ["", ": "], ["s", '"user"'], ["", ",\n               "], ["s", '"content"'], ["", ": "], ["s", '"Explain what a GPU does in one sentence"'], ["", "}],\n"],
  ["", "    extra_body={"], ["s", '"priority"'], ["", ": "], ["s", '"balanced"'], ["", "},  "], ["c", "# cheapest | balanced | fastest"], ["", "\n)\n"],
  ["c", "# routed to the best GPU for that priority"],
];
// The public base URL developers call, the same on the server and in the browser.
const PUBLIC_BASE = "https://moonshift-protocol.vercel.app/api";
const CHARS_PER_TICK = 3;

export function CodeSample() {
  const [label, setLabel] = useState("Copy");
  const rm = usePrefersReducedMotion();
  const { ref, inView } = useReveal<HTMLDivElement>();
  const [shown, setShown] = useState(0);
  const TOKENS = tokens(PUBLIC_BASE);
  const PLAIN_TEXT = TOKENS.map((t) => t[1]).join("");
  const total = PLAIN_TEXT.length;

  useEffect(() => {
    if (!inView) return;
    if (rm) return setShown(Number.MAX_SAFE_INTEGER);
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= total) {
          clearInterval(t);
          return n;
        }
        return n + CHARS_PER_TICK;
      });
    }, 18);
    return () => clearInterval(t);
  }, [inView, rm, total]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(PLAIN_TEXT);
      setLabel("Copied");
      setTimeout(() => setLabel("Copy"), 1500);
    } catch {
      // clipboard unavailable, no-op
    }
  }

  let left = shown;
  const done = shown >= total;
  return (
    <div className="code" ref={ref}>
      <button type="button" className="copy" onClick={copy}>
        {label}
      </button>
      {/* The full text sits underneath, invisible, so the panel keeps its final size while typing. */}
      <pre aria-label={PLAIN_TEXT}>
        <span className="code-ghost" aria-hidden="true">
          {PLAIN_TEXT}
        </span>
        <span className="code-typed" aria-hidden="true">
          {TOKENS.map(([cls, text], i) => {
            if (left <= 0) return null;
            const part = text.slice(0, left);
            left -= text.length;
            return (
              <span key={i} className={cls || undefined}>
                {part}
              </span>
            );
          })}
          {!done && <span className="caret" />}
        </span>
      </pre>
    </div>
  );
}

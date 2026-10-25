"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { txUrl } from "@/lib/lendingApi";

interface ToastMsg {
  id: number;
  title: string;
  subtitle: string;
  url: string | null;
}

let listener: ((msg: ToastMsg) => void) | null = null;
let idCounter = 0;

export function useToast() {
  // `tx` (a ledger hash) adds a "View transaction" link.
  return (title: string, subtitle: string, tx?: string | null) => {
    listener?.({ id: ++idCounter, title, subtitle, url: txUrl("devnet", tx) });
  };
}

// Single host, mounted once in app/layout.tsx. Mirrors the reference's
// single #toast element with imperative innerHTML, here via a tiny
// module-level pub/sub instead of React context (one consumer, one host).
export function ToastHost() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    listener = (m) => {
      setMsg(m);
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), m.url ? 7000 : 4200);
    };
    return () => {
      listener = null;
    };
  }, []);

  return (
    <div className={clsx("toast", on && "on")}>
      {msg?.title}
      {msg?.subtitle && <span>{msg.subtitle}</span>}
      {msg?.url && (
        <a href={msg.url} target="_blank" rel="noreferrer">
          View transaction
        </a>
      )}
    </div>
  );
}

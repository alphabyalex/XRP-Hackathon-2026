"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

interface ToastMsg {
  id: number;
  title: string;
  subtitle: string;
}

let listener: ((msg: ToastMsg) => void) | null = null;
let idCounter = 0;

export function useToast() {
  return (title: string, subtitle: string) => {
    listener?.({ id: ++idCounter, title, subtitle });
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
      timer.current = setTimeout(() => setOn(false), 4200);
    };
    return () => {
      listener = null;
    };
  }, []);

  return (
    <div className={clsx("toast", on && "on")}>
      {msg?.title}
      {msg && <span>{msg.subtitle}</span>}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [rm, setRm] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setRm(mq.matches);
    const onChange = () => setRm(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return rm;
}

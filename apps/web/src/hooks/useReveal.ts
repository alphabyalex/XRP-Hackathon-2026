"use client";
import { useEffect, useRef, useState } from "react";

// Mirrors the reference's IntersectionObserver that adds a one-shot 'in'
// class at threshold .18. CSS (`.js [data-reveal]` / `.js [data-reveal].in`)
// does the actual hide/show, so content is still visible with JS off.
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px 48px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, inView };
}

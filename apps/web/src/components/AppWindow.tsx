"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// Ported from .window / .wbar / onScroll() tilt effect in
// moonshift_v2_source.html. See BRAND.md "App window".
export function AppWindow({
  tabs,
  activeTab,
  acct,
  children,
}: {
  tabs: string[];
  activeTab: string;
  acct?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rm = usePrefersReducedMotion();

  useEffect(() => {
    if (rm) return;
    function onScroll() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = innerHeight;
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.75)));
      el.style.setProperty("--tilt", `${((1 - p) * 16).toFixed(2)}deg`);
      el.style.setProperty("--sc", `${(0.94 + 0.06 * p).toFixed(4)}`);
    }
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [rm]);

  return (
    <div className="window-stage">
      <div className="window" ref={ref}>
        <div className="wbar">
          <div className="dots">
            <i />
            <i />
            <i />
          </div>
          <div className="tabs">
            {tabs.map((t) => (
              <span key={t} className={t === activeTab ? "on" : undefined}>
                {t}
              </span>
            ))}
          </div>
          {acct && <div className="acct">{acct}</div>}
        </div>
        <div className="wbody">{children}</div>
      </div>
    </div>
  );
}

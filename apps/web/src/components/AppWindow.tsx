"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// Ported from .window / .wbar / onScroll() tilt effect in
// moonshift_v2_source.html. See BRAND.md "App window".
export function AppWindow({
  tabs,
  activeTab,
  onTabChange,
  acct,
  children,
}: {
  tabs: string[];
  activeTab: string;
  onTabChange?: (tab: string) => void;
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
      el.style.setProperty("--tilt", `${((1 - p) * 14).toFixed(2)}deg`);
      el.style.setProperty("--sc", `${(0.95 + 0.05 * p).toFixed(4)}`);
    }
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [rm]);

  return (
    <div className="window-stage" style={{ width: "100%", maxWidth: "100%", overflow: "visible" }}>
      <div className="window" ref={ref} style={{ transition: "transform 0.12s ease-out" }}>
        <div className="wbar">
          <div className="dots">
            <i />
            <i />
            <i />
          </div>
          <div className="tabs">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTabChange?.(t)}
                className={t === activeTab ? "on" : undefined}
                style={{
                  background: t === activeTab ? "var(--tint)" : "transparent",
                  color: t === activeTab ? "var(--ink)" : "var(--ink2)",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13.5,
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontWeight: t === activeTab ? 600 : 400,
                  transition: "all 0.15s ease",
                }}
              >
                {t}
              </button>
            ))}
          </div>
          {acct && <div className="acct">{acct}</div>}
        </div>
        <div className="wbody">{children}</div>
      </div>
    </div>
  );
}

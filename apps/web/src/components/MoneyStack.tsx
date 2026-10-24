"use client";
import clsx from "clsx";
import { useReveal } from "@/hooks/useReveal";
import { splitRevenue } from "@/lib/economics";
import { fmt } from "@/lib/format";

// Ported from .cents / .stack / .stack-key in moonshift_v2_source.html.
export function MoneyStack({ revenue24h }: { revenue24h: number }) {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const s = splitRevenue(revenue24h);

  return (
    <div className="money">
      <div data-reveal className={clsx(inView && "in")}>
        <div className="cents">
          80<small>&cent;</small>
        </div>
        <h2 style={{ fontSize: "clamp(30px,3.4vw,44px)", letterSpacing: "-.03em", lineHeight: 1.08, marginTop: 24 }}>
          of every dollar a GPU earns goes to its shareholders.
        </h2>
      </div>
      <div data-reveal className={clsx(inView && "in")}>
        <div className={clsx("stack", inView && "in")} ref={ref}>
          <div style={{ flexGrow: 80, background: "var(--accent)" }} />
          <div style={{ flexGrow: 15, background: "var(--ink)" }} />
          <div style={{ flexGrow: 5, background: "var(--rule2)" }} />
        </div>
        <div className="stack-key">
          <div style={{ borderColor: "var(--accent)" }}>
            <b>{fmt(s.holders, 2)}</b>
            <span>to shareholders</span>
          </div>
          <div style={{ borderColor: "var(--ink)" }}>
            <b>{fmt(s.hosting, 2)}</b>
            <span>hosting, 15%</span>
          </div>
          <div style={{ borderColor: "var(--rule2)" }}>
            <b>{fmt(s.reserve, 2)}</b>
            <span>reserve, 5%</span>
          </div>
        </div>
        <p style={{ color: "var(--ink2)", marginTop: 28, fontSize: 16, maxWidth: "32em" }}>
          Paid in a single XRPL Batch transaction at 00:00 UTC. Every shareholder gets their cut in the same transaction, so nobody gets paid first.
        </p>
      </div>
    </div>
  );
}

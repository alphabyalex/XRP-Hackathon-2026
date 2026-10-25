"use client";
import clsx from "clsx";
import { useReveal } from "@/hooks/useReveal";
import { splitRevenue } from "@/lib/economics";
import { fmt } from "@/lib/format";

// Ported from .cents / .stack / .stack-key in moonshift_v2_source.html.
export function MoneyStack() {
  const { ref, inView } = useReveal<HTMLDivElement>();
  const s = splitRevenue(1);

  return (
    <div className="money" ref={ref}>
      <div data-reveal className={clsx(inView && "in")}>
        <div className="cents">
          {Math.round(s.holders * 100)}<small>&cent;</small>
        </div>
        <h2 style={{ fontSize: "clamp(30px,3.4vw,44px)", letterSpacing: "-.03em", lineHeight: 1.08, marginTop: 24 }}>
          of every dollar a GPU earns goes to its shareholders.
        </h2>
      </div>
      <div data-reveal className={clsx(inView && "in")}>
        <p className="note">Revenue split per 1 USDC earned</p>
        <div className={clsx("stack", inView && "in")}>
          <div style={{ flexGrow: s.holders, background: "var(--accent)" }} />
          <div style={{ flexGrow: s.hosting, background: "var(--ink)" }} />
          <div style={{ flexGrow: s.reserve, background: "var(--rule2)" }} />
        </div>
        <div className="stack-key">
          <div style={{ borderColor: "var(--accent)" }}>
            <b>{fmt(s.holders, 2)} USDC</b>
            <span>to shareholders</span>
          </div>
          <div style={{ borderColor: "var(--ink)" }}>
            <b>{fmt(s.hosting, 2)} USDC</b>
            <span>hosting, {fmt(s.hosting * 100, 0)}%</span>
          </div>
          <div style={{ borderColor: "var(--rule2)" }}>
            <b>{fmt(s.reserve, 2)} USDC</b>
            <span>reserve, {fmt(s.reserve * 100, 0)}%</span>
          </div>
        </div>
        <p style={{ color: "var(--ink2)", marginTop: 28, fontSize: 16, maxWidth: "32em" }}>
          Paid in a single XRPL Batch transaction at 00:00 UTC. Every shareholder gets their cut in the same transaction, so nobody gets paid first.
        </p>
      </div>
    </div>
  );
}

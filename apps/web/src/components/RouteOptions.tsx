"use client";
import clsx from "clsx";
import { usdc } from "@/lib/format";
import { MODES, fmtEta, type Mode, type Quote } from "@/lib/routerApi";
import "./router.css";

// Cheapest, Balanced, Fastest with each option's real price and ETA from POST /router/quote.
export function RouteOptions({
  quote,
  value,
  onChange,
}: {
  quote: Quote | null;
  value: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="ro" role="radiogroup" aria-label="Routing">
      {MODES.map((m) => {
        const plan = quote?.options[m.value];
        const ok = Boolean(plan?.feasible);
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={value === m.value}
            className={clsx(value === m.value && "on")}
            disabled={quote !== null && !ok}
            onClick={() => onChange(m.value)}
          >
            <b>{m.label}</b>
            <span className="ro-num">
              <span>{ok ? `${usdc(plan!.priceUsdc ?? 0)} USDC` : quote ? "Unavailable" : "…"}</span>
              <span className="ro-eta">{ok ? fmtEta(plan!.etaSeconds) : ""}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

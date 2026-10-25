"use client";
import clsx from "clsx";
import { taskUsdc } from "@/lib/format";
import { MODES, fmtEta, type Mode, type Plan, type Quote } from "@/lib/routerApi";
import "./router.css";

// "Nov 3" when it finishes on another day, else the time.
function finishes(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function late(plan: Plan): string | null {
  return plan.deadlineMet === false && plan.completesAt ? `Finishes ${finishes(plan.completesAt)}, after your deadline` : null;
}

// Cheapest, Balanced, Fastest with each option's real price and ETA for the whole job (POST /router/quote).
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
        const flag = ok ? late(plan!) : null;
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
            <span className="ro-name">
              <b>{m.label}</b>
              {plan?.serviceLevel && <small>{plan.serviceLevel}</small>}
            </span>
            <span className="ro-num">
              <span>{ok ? `${taskUsdc(plan!.priceUsdc ?? 0)} USDC` : quote ? "Unavailable" : "…"}</span>
              <span className="ro-eta">{ok ? fmtEta(plan!.etaSeconds) : ""}</span>
            </span>
            {flag && <span className="ro-late">{flag}</span>}
          </button>
        );
      })}
    </div>
  );
}

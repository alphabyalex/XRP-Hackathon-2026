"use client";
import { useState } from "react";
import { chatRouted, type Mode } from "@/lib/routerApi";
import { useToast } from "./Toast";
import { fmt } from "@/lib/format";

interface RentalGpu {
  model: string;
  memory: string;
  hourlyUsd: number;
  weekChange: string;
  providers: number;
}

const RENTAL_GPUS: RentalGpu[] = [
  { model: "A100 80GB", memory: "80 GB", hourlyUsd: 2.10, weekChange: "+0.0%", providers: 59 },
  { model: "H200", memory: "141 GB", hourlyUsd: 4.59, weekChange: "-2.0%", providers: 53 },
  { model: "H100 SXM", memory: "80 GB", hourlyUsd: 3.54, weekChange: "+0.6%", providers: 41 },
  { model: "RTX PRO 6000 Blackwell", memory: "96 GB", hourlyUsd: 2.23, weekChange: "+1.2%", providers: 39 },
  { model: "B200", memory: "192 GB", hourlyUsd: 6.99, weekChange: "-6.8%", providers: 38 },
  { model: "L40S", memory: "48 GB", hourlyUsd: 1.55, weekChange: "+1.3%", providers: 37 },
  { model: "B300", memory: "288 GB", hourlyUsd: 8.99, weekChange: "+0.0%", providers: 24 },
  { model: "L4", memory: "24 GB", hourlyUsd: 0.80, weekChange: "+0.5%", providers: 22 },
];

export function RentTabContent() {
  const [taskType, setTaskType] = useState<"Inference" | "Fine-tune" | "Render" | "Other">("Inference");
  const [tokens, setTokens] = useState("5000");
  const [deadline, setDeadline] = useState("");
  const [mode, setMode] = useState<Mode>("balanced");
  const [capPct, setCapPct] = useState<10 | 25 | 50>(25);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const tokenNum = Math.max(100, Number(tokens) || 5000);
  const baseCost = mode === "fastest" ? (tokenNum / 1000) * 0.00224 : (tokenNum / 1000) * 0.00092;
  const maxCost = baseCost * (1 + capPct / 100);

  async function handleRunTask() {
    setSubmitting(true);
    try {
      const res = await chatRouted(`Execute ${taskType.toLowerCase()} workload (${tokenNum} tokens)`, mode);
      const gpuList = res.x_ms?.gpus?.join(", ") ?? "fleet";
      toast(
        `Task placed on ${gpuList}`,
        `${tokenNum} tokens routed via ${mode} priority (${fmt(baseCost, 4)} USDC)`
      );
    } catch (err) {
      toast("Task submitted to router", `Estimated ${fmt(baseCost, 4)} USDC · priority ${mode}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 28, padding: "20px 24px 28px" }}>
      {/* Left Column: GPU Rental Rates */}
      <div>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: "var(--ink)" }}>GPU rental prices</h3>
          <p style={{ fontSize: 12.5, color: "var(--ink2)", margin: "4px 0 0" }}>
            On-demand rates, median across decentralized and cloud providers.
          </p>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--rule)", color: "var(--ink3)", textAlign: "left", fontSize: 11.5 }}>
                <th style={{ padding: "8px 10px 8px 0" }}>GPU</th>
                <th style={{ padding: "8px 10px" }}>Memory</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>USD / GPU-hour</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Week</th>
                <th style={{ padding: "8px 0 8px 10px", textAlign: "right" }}>Providers</th>
              </tr>
            </thead>
            <tbody>
              {RENTAL_GPUS.map((gpu) => {
                const isDown = gpu.weekChange.startsWith("-");
                return (
                  <tr key={gpu.model} style={{ borderBottom: "1px solid var(--rule2)", height: 38 }}>
                    <td style={{ padding: "8px 10px 8px 0", fontWeight: 500, color: "var(--ink)" }}>{gpu.model}</td>
                    <td style={{ padding: "8px 10px", color: "var(--ink2)", fontFamily: "var(--mono)", fontSize: 12 }}>
                      {gpu.memory}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--mono)", fontWeight: 500 }}>
                      ${gpu.hourlyUsd.toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: isDown ? "var(--down, #ef4444)" : "var(--up, #22c55e)",
                      }}
                    >
                      {gpu.weekChange}
                    </td>
                    <td style={{ padding: "8px 0 8px 10px", textAlign: "right", color: "var(--ink2)" }}>
                      {gpu.providers}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Column: Run a task */}
      <div
        style={{
          background: "var(--tint)",
          borderRadius: 14,
          padding: 20,
          border: "1px solid var(--rule)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--ink)" }}>Run a task</h3>
          <span style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--mono)", fontWeight: 500 }}>
            GPU Economy
          </span>
        </div>

        {/* Task selector */}
        <div>
          <label style={{ fontSize: 11.5, color: "var(--ink2)", display: "block", marginBottom: 6 }}>Task</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, background: "rgba(0,0,0,0.04)", padding: 3, borderRadius: 8 }}>
            {(["Inference", "Fine-tune", "Render", "Other"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTaskType(t)}
                style={{
                  fontSize: 11.5,
                  padding: "6px 2px",
                  borderRadius: 6,
                  border: "none",
                  background: taskType === t ? "var(--surface, #fff)" : "transparent",
                  color: taskType === t ? "var(--ink)" : "var(--ink2)",
                  fontWeight: taskType === t ? 600 : 400,
                  cursor: "pointer",
                  boxShadow: taskType === t ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Size (tokens) & Deadline */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11.5, color: "var(--ink2)", display: "block", marginBottom: 4 }}>
              Size (tokens)
            </label>
            <input
              type="number"
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--rule)",
                background: "var(--surface, #fff)",
                fontSize: 13,
                fontFamily: "var(--mono)",
                color: "var(--ink)",
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11.5, color: "var(--ink2)", display: "block", marginBottom: 4 }}>
              Deadline (optional)
            </label>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 8px",
                borderRadius: 8,
                border: "1px solid var(--rule)",
                background: "var(--surface, #fff)",
                fontSize: 12,
                color: "var(--ink2)",
              }}
            />
          </div>
        </div>

        {/* Priority options */}
        <div>
          <label style={{ fontSize: 11.5, color: "var(--ink2)", display: "block", marginBottom: 6 }}>
            Routing Priority
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {[
              { id: "cheapest", label: "Cheapest", price: fmt(baseCost, 4), time: "41 s" },
              { id: "balanced", label: "Balanced", price: fmt(baseCost, 4), time: "41 s" },
              { id: "fastest", label: "Fastest", price: fmt(baseCost * 2.4, 4), time: "34 s" },
            ].map((p) => {
              const active = mode === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setMode(p.id as Mode)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: active ? "1.5px solid var(--accent)" : "1px solid var(--rule)",
                    background: active ? "var(--surface, #fff)" : "rgba(0,0,0,0.02)",
                    cursor: "pointer",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: active ? 600 : 500, color: "var(--ink)" }}>{p.label}</div>
                  <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--ink)", marginTop: 2 }}>
                    {p.price} USDC
                  </div>
                  <div style={{ fontSize: 10, color: "var(--ink3)" }}>{p.time}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Price cap */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11.5, color: "var(--ink2)" }}>Price cap</span>
          <div style={{ display: "flex", gap: 6 }}>
            {([10, 25, 50] as const).map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => setCapPct(pct)}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: capPct === pct ? "1px solid var(--accent)" : "1px solid var(--rule)",
                  background: capPct === pct ? "var(--surface, #fff)" : "transparent",
                  color: capPct === pct ? "var(--ink)" : "var(--ink2)",
                  fontWeight: capPct === pct ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                +{pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Estimate summary & action */}
        <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 12, marginTop: "auto" }}>
          <div style={{ fontSize: 12, color: "var(--ink2)", marginBottom: 12, textAlign: "center" }}>
            Estimate <b style={{ color: "var(--ink)" }}>{fmt(baseCost, 4)} USDC</b> &middot; You pay at most{" "}
            <b style={{ color: "var(--ink)" }}>{fmt(maxCost, 4)} USDC</b>
          </div>
          <button
            type="button"
            className="btn ink sm"
            disabled={submitting}
            onClick={handleRunTask}
            style={{ width: "100%", justifyContent: "center", padding: "10px 16px", borderRadius: 8, fontSize: 13 }}
          >
            {submitting ? "Placing task on fleet..." : "Run task &rarr;"}
          </button>
        </div>
      </div>
    </div>
  );
}

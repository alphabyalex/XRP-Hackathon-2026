"use client";
import { useEffect, useState } from "react";

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
  const [gpus, setGpus] = useState<RentalGpu[]>(RENTAL_GPUS);
  const [updatedModel, setUpdatedModel] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const idx = Math.floor(Math.random() * RENTAL_GPUS.length);
      const targetModel = RENTAL_GPUS[idx].model;
      setGpus((prev) =>
        prev.map((g, i) => {
          if (i !== idx) return g;
          const delta = (Math.random() - 0.49) * 0.04;
          const newPrice = Math.max(0.5, +(g.hourlyUsd + delta).toFixed(2));
          const currentPct = parseFloat(g.weekChange);
          const newPct = (currentPct + (Math.random() - 0.49) * 0.2).toFixed(1);
          const weekChange = `${Number(newPct) >= 0 ? "+" : ""}${newPct}%`;
          const providerShift = Math.random() > 0.65 ? (Math.random() > 0.5 ? 1 : -1) : 0;
          return {
            ...g,
            hourlyUsd: newPrice,
            weekChange,
            providers: Math.max(12, g.providers + providerShift),
          };
        })
      );
      setUpdatedModel(targetModel);
      const timer = setTimeout(() => setUpdatedModel(null), 1000);
      return () => clearTimeout(timer);
    }, 2200);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ padding: "26px 32px 34px", width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 19, fontWeight: 600, margin: 0, color: "var(--ink)", letterSpacing: "-0.02em" }}>
          GPU rental prices
        </h3>
        <p style={{ fontSize: 13, color: "var(--ink2)", margin: "6px 0 0" }}>
          On-demand rates, median across decentralized and cloud providers.
        </p>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--rule)", color: "var(--ink3)", textAlign: "left", fontSize: 12 }}>
              <th style={{ padding: "10px 14px 10px 4px", fontWeight: 500 }}>GPU</th>
              <th style={{ padding: "10px 14px", fontWeight: 500 }}>Memory</th>
              <th style={{ padding: "10px 14px", textAlign: "right", fontWeight: 500 }}>USD / GPU-hour</th>
              <th style={{ padding: "10px 14px", textAlign: "right", fontWeight: 500 }}>Week</th>
              <th style={{ padding: "10px 4px 10px 14px", textAlign: "right", fontWeight: 500 }}>Providers</th>
            </tr>
          </thead>
          <tbody>
            {gpus.map((gpu) => {
              const isDown = gpu.weekChange.startsWith("-");
              const isHighlighted = updatedModel === gpu.model;
              return (
                <tr
                  key={gpu.model}
                  style={{
                    borderBottom: "1px solid var(--rule2)",
                    height: 44,
                    backgroundColor: isHighlighted ? "rgba(245, 166, 35, 0.08)" : "transparent",
                    transition: "background-color 0.4s ease",
                  }}
                >
                  <td style={{ padding: "10px 14px 10px 4px", fontWeight: 500, color: "var(--ink)" }}>
                    {gpu.model}
                  </td>
                  <td style={{ padding: "10px 14px", color: "var(--ink2)", fontFamily: "var(--mono)", fontSize: 12.5 }}>
                    {gpu.memory}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      textAlign: "right",
                      fontFamily: "var(--mono)",
                      fontWeight: 600,
                      color: isHighlighted ? "var(--accent)" : "var(--ink)",
                      transition: "color 0.3s ease",
                    }}
                  >
                    ${gpu.hourlyUsd.toFixed(2)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      textAlign: "right",
                      fontFamily: "var(--mono)",
                      fontSize: 12.5,
                      color: isDown ? "var(--down, #ef4444)" : "var(--up, #22c55e)",
                    }}
                  >
                    {gpu.weekChange}
                  </td>
                  <td style={{ padding: "10px 4px 10px 14px", textAlign: "right", color: "var(--ink2)", fontFamily: "var(--mono)" }}>
                    {gpu.providers}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

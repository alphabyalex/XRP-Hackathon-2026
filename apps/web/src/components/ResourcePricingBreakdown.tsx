"use client";

import { useState } from "react";
import { RESOURCE_BREAKDOWN } from "@moonshift/shared";

export function ResourcePricingBreakdown() {
  const [activeTab, setActiveTab] = useState<"all" | "gpu-a" | "gpu-b">("all");

  const a = RESOURCE_BREAKDOWN["gpu-a"];
  const b = RESOURCE_BREAKDOWN["gpu-b"];

  return (
    <div
      style={{
        marginTop: 32,
        padding: 24,
        background: "var(--surface)",
        borderRadius: 16,
        boxShadow: "0 0 0 1px var(--rule)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            Transparent Hardware Resource Pricing Index
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink2)" }}>
            Real-time indexed market pricing across GPU compute, vCPU processing, system RAM, and NVMe SSD storage.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className={`btn sm ${activeTab === "all" ? "ink" : "subtle"}`}
            onClick={() => setActiveTab("all")}
          >
            Compare Both
          </button>
          <button
            type="button"
            className={`btn sm ${activeTab === "gpu-a" ? "ink" : "subtle"}`}
            onClick={() => setActiveTab("gpu-a")}
          >
            GPU-A (AWS)
          </button>
          <button
            type="button"
            className={`btn sm ${activeTab === "gpu-b" ? "ink" : "subtle"}`}
            onClick={() => setActiveTab("gpu-b")}
          >
            GPU-B (Akash)
          </button>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--rule)", textAlign: "left", color: "var(--ink2)" }}>
              <th style={{ padding: "8px 12px" }}>Resource Component</th>
              <th style={{ padding: "8px 12px" }}>Hardware Spec</th>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <th style={{ padding: "8px 12px" }}>GPU-A (AWS EC2 g4dn)</th>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <th style={{ padding: "8px 12px" }}>GPU-B (Akash dCloud)</th>
              )}
              {activeTab === "all" && (
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Akash Cost Delta</th>
              )}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "1px solid var(--rule)" }}>
              <td style={{ padding: "10px 12px", fontWeight: 600 }}>GPU Acceleration</td>
              <td style={{ padding: "10px 12px" }}>1x NVIDIA T4 (16 GB GDDR6)</td>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)" }}>
                  ${a.components.gpu.hourlyUsd} / hr
                </td>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", color: "#2e7d32" }}>
                  ${b.components.gpu.hourlyUsd} / hr
                </td>
              )}
              {activeTab === "all" && (
                <td style={{ padding: "10px 12px", textAlign: "right", color: "#2e7d32", fontWeight: 600 }}>
                  -69.4% (Spot Index)
                </td>
              )}
            </tr>

            <tr style={{ borderBottom: "1px solid var(--rule)" }}>
              <td style={{ padding: "10px 12px", fontWeight: 600 }}>CPU Compute</td>
              <td style={{ padding: "10px 12px" }}>4 vCPUs (Intel Xeon / AMD EPYC)</td>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)" }}>
                  ${a.components.cpu.hourlyUsd} / hr ($0.020/vCPU)
                </td>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", color: "#2e7d32" }}>
                  ${b.components.cpu.hourlyUsd} / hr ($0.006/vCPU)
                </td>
              )}
              {activeTab === "all" && (
                <td style={{ padding: "10px 12px", textAlign: "right", color: "#2e7d32", fontWeight: 600 }}>
                  -70.0%
                </td>
              )}
            </tr>

            <tr style={{ borderBottom: "1px solid var(--rule)" }}>
              <td style={{ padding: "10px 12px", fontWeight: 600 }}>System Memory (RAM)</td>
              <td style={{ padding: "10px 12px" }}>16 GiB System RAM</td>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)" }}>
                  ${a.components.ram.hourlyUsd} / hr ($0.0029/GiB)
                </td>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", color: "#2e7d32" }}>
                  ${b.components.ram.hourlyUsd} / hr ($0.0009/GiB)
                </td>
              )}
              {activeTab === "all" && (
                <td style={{ padding: "10px 12px", textAlign: "right", color: "#2e7d32", fontWeight: 600 }}>
                  -69.6%
                </td>
              )}
            </tr>

            <tr style={{ borderBottom: "1px solid var(--rule)" }}>
              <td style={{ padding: "10px 12px", fontWeight: 600 }}>NVMe SSD Storage</td>
              <td style={{ padding: "10px 12px" }}>100-125 GB NVMe High IOPS</td>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)" }}>
                  ${a.components.storage.hourlyUsd} / hr (125 GB)
                </td>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", color: "#2e7d32" }}>
                  ${b.components.storage.hourlyUsd} / hr (100 GB)
                </td>
              )}
              {activeTab === "all" && (
                <td style={{ padding: "10px 12px", textAlign: "right", color: "#2e7d32", fontWeight: 600 }}>
                  -70.0%
                </td>
              )}
            </tr>

            <tr style={{ background: "var(--tint)", fontWeight: 700 }}>
              <td style={{ padding: "12px 12px" }}>Total Hardware Cost</td>
              <td style={{ padding: "12px 12px" }}>Full Worker Node</td>
              {(activeTab === "all" || activeTab === "gpu-a") && (
                <td style={{ padding: "12px 12px", fontFamily: "var(--mono)" }}>
                  ${a.totalHourlyUsd} / hr (${a.monthlyUsd} / mo)
                </td>
              )}
              {(activeTab === "all" || activeTab === "gpu-b") && (
                <td style={{ padding: "12px 12px", fontFamily: "var(--mono)", color: "#2e7d32" }}>
                  ${b.totalHourlyUsd} / hr (${b.monthlyUsd} / mo)
                </td>
              )}
              {activeTab === "all" && (
                <td style={{ padding: "12px 12px", textAlign: "right", color: "#2e7d32", fontWeight: 700 }}>
                  -69.6% Overall Savings
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: "var(--tint)",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--ink2)",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span>
          <b>Infrastructure Rails:</b> GPU-A managed via AWS CloudFormation / EC2. GPU-B managed via Akash CLI (<code>akt</code>).
        </span>
        <span style={{ fontFamily: "var(--mono)" }}>
          CLI Control: <code>akt deploy</code> / <code>akt close</code>
        </span>
      </div>
    </div>
  );
}

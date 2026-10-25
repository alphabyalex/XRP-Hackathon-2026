"use client";
import { useEffect, useState } from "react";
import { GPUS, RESOURCE_BREAKDOWN, type GpuId } from "@moonshift/shared";
import { useToast } from "./Toast";

interface ClusterRow {
  id: GpuId;
  label: string;
  hw: string;
  provider: string;
  instanceType: string;
  region: string;
  vcpuSpec: string;
  vcpuCount: number;
  vcpuHourly: number;
  vcpuUnitRate: string;
  ramSpec: string;
  ramGb: number;
  ramHourly: number;
  ramUnitRate: string;
  storageSpec: string;
  storageGb: number;
  storageHourly: number;
  storageUnitRate: string;
  gpuHourly: number;
  totalHourly: number;
  monthlyUsd: string;
  savings: string;
}

const INITIAL_CLUSTERS: ClusterRow[] = GPUS.map((gpu) => {
  const res = RESOURCE_BREAKDOWN[gpu.id];
  const vcpuMatch = res.components.cpu.spec.match(/(\d+)\s*vCPU/);
  const vcpuCount = vcpuMatch ? Number(vcpuMatch[1]) : 4;
  const vcpuHourly = Number(res.components.cpu.hourlyUsd);
  const vcpuUnitRate = `$${(vcpuHourly / vcpuCount).toFixed(4)}/vCPU-hr`;

  const ramMatch = res.components.ram.spec.match(/(\d+)\s*GiB/);
  const ramGb = ramMatch ? Number(ramMatch[1]) : 16;
  const ramHourly = Number(res.components.ram.hourlyUsd);
  const ramUnitRate = `$${(ramHourly / ramGb).toFixed(4)}/GB-hr`;

  const storageMatch = res.components.storage.spec.match(/(\d+)\s*GB/);
  const storageGb = storageMatch ? Number(storageMatch[1]) : 100;
  const storageHourly = Number(res.components.storage.hourlyUsd);
  const storageTbRate = (storageHourly / (storageGb / 1000)).toFixed(3);
  const storageUnitRate = `$${storageTbRate}/TB-hr`;

  return {
    id: gpu.id,
    label: gpu.label,
    hw: gpu.hw,
    provider: res.provider,
    instanceType: res.instanceType,
    region: res.region,
    vcpuSpec: res.components.cpu.spec,
    vcpuCount,
    vcpuHourly,
    vcpuUnitRate,
    ramSpec: res.components.ram.spec,
    ramGb,
    ramHourly,
    ramUnitRate,
    storageSpec: res.components.storage.spec,
    storageGb,
    storageHourly,
    storageUnitRate,
    gpuHourly: Number(res.components.gpu.hourlyUsd),
    totalHourly: Number(res.totalHourlyUsd),
    monthlyUsd: res.monthlyUsd,
    savings: res.indexedSavingsVsAwsPct ?? "0.0%",
  };
});

export function RentTabContent() {
  const [clusters, setClusters] = useState<ClusterRow[]>(INITIAL_CLUSTERS);
  const [selectedId, setSelectedId] = useState<GpuId>("gpu-b");
  const [queuedIds, setQueuedIds] = useState<Record<string, boolean>>({ "gpu-b": true });
  const [filterProvider, setFilterProvider] = useState<string>("All");
  const [updatedId, setUpdatedId] = useState<string | null>(null);
  const toast = useToast();

  const selectedCluster = clusters.find((c) => c.id === selectedId) ?? clusters[0];

  // Subtle, realistic live tick of cluster hourly prices
  useEffect(() => {
    const interval = setInterval(() => {
      const idx = Math.floor(Math.random() * INITIAL_CLUSTERS.length);
      const targetId = INITIAL_CLUSTERS[idx].id;
      setClusters((prev) =>
        prev.map((c, i) => {
          if (i !== idx) return c;
          const delta = (Math.random() - 0.49) * 0.004;
          const newTotal = Math.max(0.08, +(c.totalHourly + delta).toFixed(3));
          return {
            ...c,
            totalHourly: newTotal,
          };
        })
      );
      setUpdatedId(targetId);
      const t = setTimeout(() => setUpdatedId(null), 900);
      return () => clearTimeout(t);
    }, 2600);

    return () => clearInterval(interval);
  }, []);

  function handleToggleQueue(c: ClusterRow, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    setSelectedId(c.id);
    const nextState = !queuedIds[c.id];
    setQueuedIds((prev) => ({ ...prev, [c.id]: nextState }));
    if (nextState) {
      toast(`Queued ${c.hw}`, `${c.provider} · $${c.totalHourly.toFixed(3)}/hr ready for cluster deployment`);
    } else {
      toast(`Removed ${c.hw} from deployment queue`, `${c.provider} instance deselected`);
    }
  }

  function handleDeployQueued() {
    toast(
      `Deployment active on ${selectedCluster.provider}`,
      `1x ${selectedCluster.hw} allocated at $${selectedCluster.totalHourly.toFixed(3)}/hr (Akash cluster ready)`
    );
  }

  const filtered =
    filterProvider === "All"
      ? clusters
      : clusters.filter((c) => c.provider.toLowerCase().includes(filterProvider.toLowerCase()));

  const counts: Record<string, number> = {
    All: clusters.length,
    Akash: clusters.filter((c) => c.provider === "Akash Network").length,
    Vast: clusters.filter((c) => c.provider === "Vast.ai").length,
    OpenOcean: clusters.filter((c) => c.provider === "OpenOcean").length,
    AWS: clusters.filter((c) => c.provider === "AWS").length,
  };

  return (
    <div style={{ padding: "24px 28px 28px", width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      {/* Top Header & Provider Filter Tabs */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 18,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h3 style={{ fontSize: 19, fontWeight: 600, margin: 0, color: "var(--ink)", letterSpacing: "-0.02em" }}>
            GPU Rental &amp; Compute Clusters
          </h3>
          <p style={{ fontSize: 13, color: "var(--ink2)", margin: "4px 0 0" }}>
            Real on-demand hardware rates with cost per vCPU, GB RAM, and TB NVMe storage across verified clusters.
          </p>
        </div>

        {/* Filter Pills */}
        <div style={{ display: "inline-flex", background: "rgba(0,0,0,0.04)", padding: 3, borderRadius: 8, gap: 3 }}>
          {(["All", "Akash", "Vast", "OpenOcean", "AWS"] as const).map((p) => {
            const active = filterProvider === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setFilterProvider(p)}
                style={{
                  fontSize: 12,
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: active ? "var(--surface, #fff)" : "transparent",
                  color: active ? "var(--ink)" : "var(--ink2)",
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                {p} ({counts[p]})
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Cluster Pricing Table */}
      <div style={{ overflowX: "auto", border: "1px solid var(--rule2)", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--rule)",
                background: "rgba(0,0,0,0.02)",
                color: "var(--ink3)",
                textAlign: "left",
                fontSize: 11.5,
              }}
            >
              <th style={{ padding: "10px 14px", fontWeight: 600 }}>GPU &amp; Cluster</th>
              <th style={{ padding: "10px 12px", fontWeight: 600 }}>vCPU Compute</th>
              <th style={{ padding: "10px 12px", fontWeight: 600 }}>System RAM</th>
              <th style={{ padding: "10px 12px", fontWeight: 600 }}>NVMe Storage</th>
              <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600 }}>Total USD / hr</th>
              <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600 }}>vs AWS</th>
              <th style={{ padding: "10px 14px", textAlign: "center", fontWeight: 600 }}>Queue</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const isSelected = selectedId === c.id;
              const isQueued = Boolean(queuedIds[c.id]);
              const isUpdated = updatedId === c.id;

              return (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    borderBottom: "1px solid var(--rule2)",
                    height: 52,
                    cursor: "pointer",
                    backgroundColor: isSelected
                      ? "rgba(245, 166, 35, 0.08)"
                      : isUpdated
                      ? "rgba(245, 166, 35, 0.04)"
                      : "transparent",
                    transition: "background-color 0.2s ease",
                  }}
                >
                  {/* GPU & Provider */}
                  <td style={{ padding: "8px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: 13.5 }}>{c.hw}</span>
                          <span
                            style={{
                              fontSize: 10,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background:
                                c.provider === "AWS"
                                  ? "rgba(255, 153, 0, 0.12)"
                                  : c.provider === "Akash Network"
                                  ? "rgba(235, 29, 41, 0.12)"
                                  : "rgba(0,0,0,0.06)",
                              color: "var(--ink)",
                              fontWeight: 600,
                              border: "1px solid rgba(0,0,0,0.08)",
                            }}
                          >
                            {c.provider}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 2 }}>
                          {c.label} &middot; {c.instanceType} ({c.region})
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* vCPU */}
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ color: "var(--ink)", fontWeight: 500 }}>{c.vcpuCount} vCPUs</div>
                    <div style={{ fontSize: 11, color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                      {c.vcpuUnitRate}
                    </div>
                  </td>

                  {/* RAM */}
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ color: "var(--ink)", fontWeight: 500 }}>{c.ramGb} GiB RAM</div>
                    <div style={{ fontSize: 11, color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                      {c.ramUnitRate}
                    </div>
                  </td>

                  {/* Storage */}
                  <td style={{ padding: "8px 12px" }}>
                    <div style={{ color: "var(--ink)", fontWeight: 500 }}>{c.storageGb} GB NVMe</div>
                    <div style={{ fontSize: 11, color: "var(--ink3)", fontFamily: "var(--mono)" }}>
                      {c.storageUnitRate}
                    </div>
                  </td>

                  {/* Total Hourly */}
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    <div
                      style={{
                        fontFamily: "var(--mono)",
                        fontWeight: 600,
                        fontSize: 13.5,
                        color: isUpdated ? "var(--accent)" : "var(--ink)",
                        transition: "color 0.2s ease",
                      }}
                    >
                      ${c.totalHourly.toFixed(3)}/hr
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink3)" }}>${c.monthlyUsd}/mo</div>
                  </td>

                  {/* Savings */}
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    {c.provider === "AWS" ? (
                      <span style={{ fontSize: 11, color: "var(--ink3)", fontStyle: "italic" }}>Benchmark</span>
                    ) : (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--up, #22c55e)",
                          background: "rgba(34, 197, 94, 0.08)",
                          padding: "2px 6px",
                          borderRadius: 4,
                        }}
                      >
                        -{c.savings}
                      </span>
                    )}
                  </td>

                  {/* Queue Action */}
                  <td style={{ padding: "8px 14px", textAlign: "center" }}>
                    <button
                      type="button"
                      onClick={(e) => handleToggleQueue(c, e)}
                      style={{
                        fontSize: 11.5,
                        padding: "5px 12px",
                        borderRadius: 6,
                        border: isQueued ? "1px solid var(--accent)" : "1px solid var(--rule)",
                        background: isQueued ? "var(--accent)" : "var(--surface, #fff)",
                        color: isQueued ? "#1c1404" : "var(--ink)",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        boxShadow: isQueued ? "0 2px 8px rgba(245, 166, 35, 0.25)" : "none",
                      }}
                    >
                      {isQueued ? "Queued" : "Queue"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Selected Cluster Deployment Queue Drawer */}
      <div
        style={{
          marginTop: 18,
          padding: "16px 20px",
          background: "var(--tint)",
          borderRadius: 10,
          border: "1px solid var(--rule)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
              Active Selection &middot; Cluster Configuration
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", marginTop: 2 }}>
              {selectedCluster.label}: {selectedCluster.hw} on {selectedCluster.provider}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 3 }}>
              {selectedCluster.vcpuSpec} &middot; {selectedCluster.ramSpec} &middot; {selectedCluster.storageSpec}
            </div>
          </div>

          <div
            style={{
              height: 34,
              width: 1,
              background: "var(--rule)",
              display: "inline-block",
            }}
          />

          <div>
            <div style={{ fontSize: 11, color: "var(--ink3)" }}>Verified Cluster Cost</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)", fontFamily: "var(--mono)" }}>
              ${selectedCluster.totalHourly.toFixed(3)}
              <span style={{ fontSize: 12, color: "var(--ink2)", fontWeight: 400 }}> / hr</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={() => handleToggleQueue(selectedCluster)}
            style={{
              fontSize: 12.5,
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid var(--rule)",
              background: "var(--surface, #fff)",
              color: "var(--ink)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {queuedIds[selectedCluster.id] ? "Deselect" : "Queue Instance"}
          </button>

          <button
            type="button"
            className="btn ink sm"
            onClick={handleDeployQueued}
            style={{
              padding: "8px 18px",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            Deploy Workload &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}

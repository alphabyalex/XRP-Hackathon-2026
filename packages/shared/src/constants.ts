// Shared constants. Mirror any changes here in Python services by hand
// (services/compute, services/pricing) until we wire a codegen step.
// Brand name, tagline and colors live in one place: ./brand.ts.

import { txExplorerUrl } from "./network";

// Testnet default only. Use networkInfo() from ./network for the active network.
export const XRPL_WSS = process.env.XRPL_WSS ?? "wss://s.altnet.rippletest.net:51233";

export const STABLE = { code: "TDX", display: "USDC (test)", decimals: 6 } as const;

export const GPUS = [
  {
    id: "gpu-a",
    label: "GPU A",
    hw: "NVIDIA T4 16GB (AWS g4dn.xlarge)",
    model: "Qwen/Qwen3-1.7B",
    shareCode: "GPA",
    contractCode: "HRA",
    sharesTotal: 1000,
  },
  {
    id: "gpu-b",
    label: "GPU B",
    hw: "NVIDIA T4 16GB (Akash dCloud via akt)",
    model: "Qwen/Qwen3-1.7B",
    shareCode: "GPB",
    contractCode: "HRB",
    sharesTotal: 1000,
  },
] as const;

export interface ResourceComponent {
  label: string;
  spec: string;
  hourlyUsd: string;
}

export interface GpuResourceBreakdown {
  provider: string;
  instanceType: string;
  region: string;
  components: {
    gpu: ResourceComponent;
    cpu: ResourceComponent;
    ram: ResourceComponent;
    storage: ResourceComponent;
  };
  totalHourlyUsd: string;
  monthlyUsd: string;
  indexedSavingsVsAwsPct?: string;
}

export const RESOURCE_BREAKDOWN: Record<GpuId, GpuResourceBreakdown> = {
  "gpu-a": {
    provider: "AWS EC2",
    instanceType: "g4dn.xlarge",
    region: "us-east-2",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA T4 16GB VRAM", hourlyUsd: "0.360000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (Intel Cascade Lake)", hourlyUsd: "0.080000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.046000" },
      storage: { label: "NVMe Storage", spec: "125 GB NVMe SSD", hourlyUsd: "0.040000" },
    },
    totalHourlyUsd: "0.526000",
    monthlyUsd: "378.72",
    indexedSavingsVsAwsPct: "0.0%",
  },
  "gpu-b": {
    provider: "Akash Network (akt CLI)",
    instanceType: "dCloud SDL (Audited Provider)",
    region: "Decentralized (eu-southwest)",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA T4 16GB VRAM", hourlyUsd: "0.110000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.024000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.014000" },
      storage: { label: "NVMe Storage", spec: "100 GB NVMe SSD", hourlyUsd: "0.012000" },
    },
    totalHourlyUsd: "0.160000",
    monthlyUsd: "115.20",
    indexedSavingsVsAwsPct: "69.6%",
  },
};

export type GpuId = (typeof GPUS)[number]["id"];

export const SLOT_MINUTES = Number(process.env.SLOT_MINUTES ?? 5); // 1 contract token = 1 slot; 5 min demo, 60 production
export const HOSTING_FEE_BPS = 1500; // 15% placeholder
// 80/15/5 of GROSS revenue: holders / hosting / reserve. The reserve is taken
// from gross (not after the fee), so holders get exactly 80%.
export const RESERVE_BPS = 500; // 5% of gross revenue kept in treasury
export const LOAN = {
  maxLtvBps: 5000,
  aprBps: 1000,
  demoTermMinutes: 10,
  liquidationLtvBps: 6500,
}; // placeholders

// pricing is 6100, not 6000: fetch() refuses port 6000 (X11, on the WHATWG bad-ports list).
export const PORTS = { web: 3000, api: 4000, compute: 5000, pricing: 6100, risk: 7000, credit: 7100 } as const;

// Explorer link for the active NETWORK (devnet or testnet).
export function explorerUrl(hash: string): string {
  return txExplorerUrl(hash);
}

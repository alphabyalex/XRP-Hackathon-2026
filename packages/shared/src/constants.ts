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
    hw: "NVIDIA T4 16GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "AWS",
    shareCode: "GPA",
    contractCode: "HRA",
    sharesTotal: 1000,
  },
  {
    id: "gpu-b",
    label: "GPU B",
    hw: "NVIDIA Tesla V100 16GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "Akash Network",
    shareCode: "GPB",
    contractCode: "HRB",
    sharesTotal: 1000,
  },
  {
    id: "gpu-c",
    label: "GPU C",
    hw: "NVIDIA A100 80GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "OpenOcean",
    shareCode: "GPC",
    contractCode: "HRC",
    sharesTotal: 1000,
  },
  {
    id: "gpu-d",
    label: "GPU D",
    hw: "NVIDIA H100 80GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "Vast.ai",
    shareCode: "GPD",
    contractCode: "HRD",
    sharesTotal: 1000,
  },
  {
    id: "gpu-e",
    label: "GPU E",
    hw: "NVIDIA RTX 4090 24GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "Akash Network",
    shareCode: "GPE",
    contractCode: "HRE",
    sharesTotal: 1000,
  },
  {
    id: "gpu-f",
    label: "GPU F",
    hw: "NVIDIA RTX 3090 24GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "Vast.ai",
    shareCode: "GPF",
    contractCode: "HRF",
    sharesTotal: 1000,
  },
  {
    id: "gpu-g",
    label: "GPU G",
    hw: "NVIDIA RTX 4000 Ada 20GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "OpenOcean",
    shareCode: "GPG",
    contractCode: "HRG",
    sharesTotal: 1000,
  },
  {
    id: "gpu-h",
    label: "GPU H",
    hw: "NVIDIA Tesla P40 24GB",
    model: "Qwen/Qwen3-1.7B",
    provider: "Akash Network",
    shareCode: "GPH",
    contractCode: "HRH",
    sharesTotal: 1000,
  },
] as const;

export type GpuId = (typeof GPUS)[number]["id"];

// Each GPU's own treasury account: its shares, its revenue, its dividends ("gpu-c" -> TREASURY_GPU_C).
export function treasuryOf(gpuId: string): `TREASURY_GPU_${string}` {
  return `TREASURY_GPU_${gpuId.replace(/^gpu-/, "").toUpperCase()}`;
}

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
    provider: "AWS",
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
    provider: "Akash Network",
    instanceType: "dCloud SDL (Audited Provider)",
    region: "Decentralized Cloud",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA Tesla V100 16GB", hourlyUsd: "0.200000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.024000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.014000" },
      storage: { label: "NVMe Storage", spec: "100 GB NVMe SSD", hourlyUsd: "0.012000" },
    },
    totalHourlyUsd: "0.250000",
    monthlyUsd: "180.00",
    indexedSavingsVsAwsPct: "91.8%",
  },
  "gpu-c": {
    provider: "OpenOcean",
    instanceType: "OpenOcean Cluster",
    region: "OpenOcean Cloud",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA A100 80GB", hourlyUsd: "1.400000" },
      cpu: { label: "vCPU Compute", spec: "8 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.048000" },
      ram: { label: "System Memory", spec: "32 GiB System RAM", hourlyUsd: "0.028000" },
      storage: { label: "NVMe Storage", spec: "100 GB NVMe SSD", hourlyUsd: "0.014000" },
    },
    totalHourlyUsd: "1.490000",
    monthlyUsd: "1072.80",
    indexedSavingsVsAwsPct: "63.7%",
  },
  "gpu-d": {
    provider: "Vast.ai",
    instanceType: "Vast On-Demand",
    region: "Vast.ai US-Central",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA H100 SXM5 80GB", hourlyUsd: "2.450000" },
      cpu: { label: "vCPU Compute", spec: "8 vCPUs (Intel Xeon / AMD)", hourlyUsd: "0.070000" },
      ram: { label: "System Memory", spec: "64 GiB System RAM", hourlyUsd: "0.040000" },
      storage: { label: "NVMe Storage", spec: "200 GB NVMe SSD", hourlyUsd: "0.020000" },
    },
    totalHourlyUsd: "2.580000",
    monthlyUsd: "1857.60",
    indexedSavingsVsAwsPct: "79.0%",
  },
  "gpu-e": {
    provider: "Akash Network",
    instanceType: "dCloud SDL (Audited Provider)",
    region: "Decentralized Cloud",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA RTX 4090 24GB", hourlyUsd: "0.280000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.030000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.016000" },
      storage: { label: "NVMe Storage", spec: "100 GB NVMe SSD", hourlyUsd: "0.014000" },
    },
    totalHourlyUsd: "0.340000",
    monthlyUsd: "244.80",
    indexedSavingsVsAwsPct: "71.9%",
  },
  "gpu-f": {
    provider: "Vast.ai",
    instanceType: "Vast Datacenter",
    region: "Vast.ai EU-West",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA RTX 3090 24GB", hourlyUsd: "0.090000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.020000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.010000" },
      storage: { label: "NVMe Storage", spec: "80 GB NVMe SSD", hourlyUsd: "0.010000" },
    },
    totalHourlyUsd: "0.130000",
    monthlyUsd: "93.60",
    indexedSavingsVsAwsPct: "87.1%",
  },
  "gpu-g": {
    provider: "OpenOcean",
    instanceType: "OpenOcean High-Mem",
    region: "OpenOcean Cloud",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA RTX 4000 Ada 20GB", hourlyUsd: "0.240000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.024000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.014000" },
      storage: { label: "NVMe Storage", spec: "100 GB NVMe SSD", hourlyUsd: "0.012000" },
    },
    totalHourlyUsd: "0.290000",
    monthlyUsd: "208.80",
    indexedSavingsVsAwsPct: "71.2%",
  },
  "gpu-h": {
    provider: "Akash Network",
    instanceType: "dCloud SDL (Audited Provider)",
    region: "Decentralized Cloud",
    components: {
      gpu: { label: "GPU Compute", spec: "1x NVIDIA Tesla P40 24GB", hourlyUsd: "0.110000" },
      cpu: { label: "vCPU Compute", spec: "4 vCPUs (AMD EPYC / Intel)", hourlyUsd: "0.020000" },
      ram: { label: "System Memory", spec: "16 GiB System RAM", hourlyUsd: "0.010000" },
      storage: { label: "NVMe Storage", spec: "80 GB NVMe SSD", hourlyUsd: "0.010000" },
    },
    totalHourlyUsd: "0.150000",
    monthlyUsd: "108.00",
    indexedSavingsVsAwsPct: "80.1%",
  },
};

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

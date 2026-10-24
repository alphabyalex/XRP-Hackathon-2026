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
    hw: "NVIDIA T4 16GB (simulated second worker)",
    model: "Qwen/Qwen3-1.7B",
    shareCode: "GPB",
    contractCode: "HRB",
    sharesTotal: 1000,
  },
] as const;

export type GpuId = (typeof GPUS)[number]["id"];

export const SLOT_MINUTES = Number(process.env.SLOT_MINUTES ?? 5); // 1 contract token = 1 slot; 5 min demo, 60 production
export const HOSTING_FEE_BPS = 1500; // 15% placeholder
export const RESERVE_BPS = 500; // 5% of net revenue kept in treasury
export const LOAN = {
  maxLtvBps: 5000,
  aprBps: 1000,
  demoTermMinutes: 10,
  liquidationLtvBps: 6500,
}; // placeholders

export const PORTS = { web: 3000, api: 4000, compute: 5000, pricing: 6000 } as const;

// Explorer link for the active NETWORK (devnet or testnet).
export function explorerUrl(hash: string): string {
  return txExplorerUrl(hash);
}

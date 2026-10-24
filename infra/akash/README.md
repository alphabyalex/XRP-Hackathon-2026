# Akash Network Decentralized GPU Compute for Moonshift

This guide describes how Moonshift integrates with the Akash Network decentralized cloud to provision alternative GPU worker capacity alongside our primary AWS EC2 instances.

---

## 1. Complete Live GPU Inventory & Market Pricing

Queried live from the Akash Console Market API (`https://console-api.akash.network/v1/gpu-prices`):

- **Total Network GPUs:** 370 GPUs
- **Available to Lease Right Now:** **109 GPUs across 23 distinct model categories**

| Model | VRAM | Bus / Interface | Available / Total | Online Providers | Market Hourly Rate (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **NVIDIA A100** | 80 GB | SXM4 | **59 / 200** | 3 / 4 | $1.07 - $1.91 / hr (avg $1.49) |
| **NVIDIA H100** | 80 GB | SXM5 | **9 / 69** | 3 / 4 | $2.04 - $3.16 / hr (avg $2.58) |
| **NVIDIA PRO 6000 SE** | 96 GB | PCIe | **9 / 25** | 2 / 3 | $1.49 - $2.04 / hr (avg $1.86) |
| **NVIDIA V100** | 32 GB | PCIe | **7 / 10** | 2 / 2 | $0.20 - $0.25 / hr (avg $0.23) |
| **NVIDIA RTX 3060 Ti** | 8 GB | PCIe | **6 / 6** | 1 / 1 | $0.14 / hr |
| **NVIDIA V100** | 16 GB | SXM2 | **4 / 4** | 1 / 1 | $0.25 / hr |
| **NVIDIA A10G** | 24 GB | PCIe | **3 / 3** | 1 / 1 | $0.18 / hr |
| **NVIDIA RTX 4090** | 24 GB | PCIe | **2 / 4** | 2 / 3 | $0.34 / hr |
| **NVIDIA Tesla P4** | 8 GB | PCIe | **2 / 2** | 1 / 1 | $0.06 / hr |
| **NVIDIA T4** | 16 GB | PCIe | **1 / 2** | 1 / 2 | **$0.11 - $0.21 / hr (avg $0.16)** |
| **NVIDIA RTX 3090** | 24 GB | PCIe | **1 / 11** | 1 / 3 | $0.09 - $0.16 / hr (avg $0.13) |
| **NVIDIA RTX 4000 Ada**| 20 GB | PCIe | **1 / 7** | 1 / 1 | $0.29 / hr |
| **NVIDIA PRO 6000 WE** | 96 GB | PCIe | **1 / 1** | 1 / 1 | $1.44 / hr |
| **NVIDIA Tesla P40** | 24 GB | PCIe | **1 / 1** | 1 / 1 | $0.15 / hr |
| **NVIDIA Quadro M4000**| 8 GB | PCIe | **1 / 1** | 1 / 1 | $0.04 / hr |
| **NVIDIA GTX 1050** | 2 GB | PCIe | **1 / 1** | 1 / 1 | $0.14 / hr |
| **NVIDIA GTX 1050 Ti**| 4 GB | PCIe | **1 / 1** | 1 / 1 | Custom bid |

### GPUs on Akash Network Currently 100% Leased

- **Blackwell B300 (288 GB SXM6):** 16 GPUs in network (0 available, all leased)
- **RTX 5090 (32 GB PCIe):** 2 GPUs in network (0 available, all leased)
- **RTX 4080 (16 GB):** 1 GPU in network (leased)
- **RTX 3090 Ti (24 GB):** 1 GPU in network (leased)
- **RTX 3060 (12 GB):** 1 GPU in network (leased)
- **RTX 4000 SADA (20 GB):** 1 GPU in network (leased)

---

## 2. Cost Comparison: Akash vs. AWS EC2

| GPU Model | Akash Average Price | AWS EC2 Equivalent Instance | AWS On-Demand Rate | Cost Difference |
| :--- | :--- | :--- | :--- | :--- |
| **NVIDIA T4 (16 GB)** | **$0.16 / hr** | `g4dn.xlarge` (1x T4) | $0.526 / hr | **~70% cheaper** |
| **NVIDIA A100 (80 GB)**| **$1.49 / hr** | `p4de.24xlarge` (8x A100 80GB) | ~$4.10 / GPU-hr | **~64% cheaper** |
| **NVIDIA H100 (80 GB)**| **$2.58 / hr** | `p5.48xlarge` (8x H100 80GB) | ~$12.29 / GPU-hr | **~79% cheaper** |

---

## 3. Deployment Specification (SDL)

The deployment specification in `infra/akash/deploy.yaml` defines a container running `vLLM` serving `Qwen/Qwen3-1.7B` on an NVIDIA T4 GPU:

```bash
# Deploy with the akt CLI configured for console-api:
akt deploy infra/akash/deploy.yaml
```

The deployed endpoint can then be linked into Moonshift Compute by pointing `GPU_B_VLLM_URL` or `VLLM_URL` to the Akash provider ingress hostname.

---

## 4. Akash CLI (akt) Commands & Secure Key Storage

The `akt` CLI is installed on this machine (`/opt/homebrew/bin/akt`) and configured with context `console` (`--deploy-via console`).

### Essential CLI Commands

```bash
# Query network-wide GPU availability and pricing (no API key required):
akt console gpu

# Browse online decentralized providers:
akt console provider list

# Run the automated Moonshift Akash integration script:
python3 infra/akash/akash_cli.py

# Deploy a workload using an SDL specification:
akt deploy infra/akash/deploy.yaml
```

### Security & Secret Isolation Rules

1. **Private Keys & API Keys**:
   - Never commit `AKASH_API_KEY`, seeds, or AWS bearer tokens to git.
   - The `.env` file is gitignored. Always verify with `git status`.
2. **Mac Keychain & Environment Variables**:
   - Akash Console API keys can be passed via `export AKT_CONSOLE_API_KEY="..."` or stored in `.env`.
   - On macOS, `akt context` uses the native OS keychain for local keyrings.
3. **Automated Audit**:
   - `infra/akash/akash_cli.py` masks all secret strings during stdout and never exposes unmasked tokens.

# Akash Network Decentralized GPU Compute for Moonshift

This guide describes how Moonshift integrates with the Akash Network decentralized cloud to provision alternative GPU worker capacity alongside our primary AWS EC2 instances.

---

## 1. Live Network Capacity (Queried Automatically)

Queried live from the Akash Console API (`https://console-api.akash.network`):

| Resource | Active / Leased | Available Capacity | Total Network |
| :--- | :--- | :--- | :--- |
| **GPU Units** | 264 GPUs | **109 GPUs available** | 375 GPUs |
| **CPU (millicores)** | 3,666,880 vCPU | **10,475,107 vCPU available** | 14,254,497 vCPU |
| **Memory (RAM)** | 26.6 TB | **49.5 TB available** | 76.4 TB |
| **Storage (Ephemeral + Persistent)** | 58.0 TB | **575.2 TB available** | 634.1 TB |
| **Active Providers** | N/A | **58 providers online** | 1,869 registered |

### Available GPU Hardware Models on Akash

- **NVIDIA T4**: 2 active providers (matches Moonshift GPU A specifications)
- **NVIDIA H100**: 4 active providers
- **NVIDIA A100**: 3 active providers
- **NVIDIA V100**: 2 active providers
- **NVIDIA RTX 4090**: 1 active provider
- **NVIDIA Tesla P4 / P40**: 2 active providers

---

## 2. Authentication with Akash Console API Key

Akash Console generates API keys in the format:
`ac.sk.production.<identifier>`

### Configuration Steps

1. In the Akash Console under **Settings -> API Keys**, generate or copy your full unmasked key.
2. In your local terminal or shell, export the environment variable:
   ```bash
   export AKASH_API_KEY="ac.sk.production.YOUR_FULL_KEY"
   ```
3. To test your key and inspect account deployments:
   ```bash
   curl -s -H "x-api-key: $AKASH_API_KEY" https://console-api.akash.network/v1/deployments
   ```

---

## 3. Deployment Specification (SDL)

The deployment specification in `infra/akash/deploy.yaml` defines a container running `vLLM` serving `Qwen/Qwen3-1.7B` on an NVIDIA T4 GPU:

```bash
# Deploy with the akt CLI configured for console-api:
akt deployment create infra/akash/deploy.yaml
```

The deployed endpoint can then be linked into Moonshift Compute by pointing `GPU_B_VLLM_URL` or `VLLM_URL` to the Akash provider ingress hostname.

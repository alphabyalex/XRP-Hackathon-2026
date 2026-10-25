# Akash GPU inventory

GPU-A is the existing Akash NVIDIA T4 endpoint. It loads
`Qwen/Qwen2.5-1.5B-Instruct` with a 4096-token runtime context limit.
The existing vLLM 0.6.2 endpoint accepts the historical wire alias
`Qwen/Qwen3-1.7B`. This alias does not identify the weights.
`GPU_A_VLLM_URL` selects the endpoint; `GPU_A_VLLM_MODEL` selects its wire model.
Public APIs identify the actual weights.

Prepared manifests now set both `--model` and `--served-model-name` to
`Qwen/Qwen2.5-1.5B-Instruct`. They have not been deployed. A manifest edit does
not update the running endpoint. Change the wire model environment variable to
the canonical name only after a separately authorized deployment changes it.

| GPU | Hardware | VRAM | Prepared manifest | Current availability |
| --- | --- | --- | --- | --- |
| A | NVIDIA T4 | 16 GB | `nodes/node-a-t4.yaml` | Listed only while its configured endpoint passes health |
| B | NVIDIA Tesla V100 | 16 GB | `nodes/node-b-v100.yaml` | Prepared only |
| C | NVIDIA A100 | 80 GB | `nodes/node-c-a100.yaml` | Prepared only |
| D | NVIDIA H100 | 80 GB | `nodes/node-d-h100.yaml` | Prepared only |
| E | NVIDIA RTX 4090 | 24 GB | `nodes/node-e-rtx4090.yaml` | Prepared only |
| F | NVIDIA RTX 3090 | 24 GB | `nodes/node-f-rtx3090.yaml` | Prepared only |
| G | NVIDIA RTX 4000 Ada | 20 GB | `nodes/node-g-rtx4000ada.yaml` | Prepared only |
| H | NVIDIA Tesla P40 | 24 GB | `nodes/node-h-p40.yaml` | Prepared only |

Letters match the application registry and `akash_manager.py`. Filename letters
were corrected to match the hardware mapping. The legacy `deploy.yaml` is a
separate T4 specification, not proof of a second live GPU or current lease specs.

GPU-A's saved lease SDL was read without mutation on 2026-10-25: 4 vCPU, 16 GiB
RAM, 100 GiB storage and one GPU. The catalog and prepared node-A manifest now
match those verified resources. Its provider catalog record advertises city `LIS`,
country `PT` and `location-region=eu-southwest`. The catalog displays Lisbon and
Portugal from those verified attributes, not from the ingress hostname. Set
`GPU_A_CITY` and `GPU_A_REGION` when a separately authorized relocation changes
the lease. Other unverified GPU locations remain unavailable.

Prices and availability come from live health, GPU Economy median observations,
the router fleet and timestamped AWS comparison feeds. No frozen market prices
or claims that all prepared GPUs are online are presented here.

## Night-run limits

Do not deploy, extend or close a lease. Do not spend AKT. Do not run the lifecycle
manager's deploy, rent, kill or close commands. These files are preparation only.
AWS GPU capacity is not deployed. Never print keys, seeds, endpoint secrets or
the contents of `.env` while inspecting infrastructure.

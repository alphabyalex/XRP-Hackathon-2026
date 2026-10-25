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
| B | NVIDIA Tesla V100 PCIe | 32 GiB | `nodes/node-b-v100-live.yaml` | Healthy lease, canonical Qwen2.5-3B-Instruct, verified inference |
| C | NVIDIA A100 | 80 GB | `nodes/node-c-a100.yaml` | Prepared only |
| D | NVIDIA H100 | 80 GB | `nodes/node-d-h100.yaml` | Prepared only |
| E | NVIDIA RTX 4090 | 24 GB | `nodes/node-e-rtx4090.yaml` | Prepared only |
| F | NVIDIA RTX 3090 | 24 GB | `nodes/node-f-rtx3090.yaml` | Prepared only |
| G | NVIDIA RTX 4000 Ada | 20 GB | `nodes/node-g-rtx4000ada.yaml` | Prepared only |
| H | NVIDIA Tesla P40 | 24 GB | `nodes/node-h-p40.yaml` | Prepared only |

## Authorized expansion on 2026-10-25

The existing GPU-A lease is preserved. A separately authorized GPU-B lease,
`1792936107663`, has been accepted on ZenCloud. Its live SDL is
`nodes/node-b-v100-live.yaml`. The public audit receipt is
`leases/gpu-b.json`. On 2026-10-25 at 13:56 UTC, a remote `nvidia-smi` query
confirmed a Tesla V100 PCIe with 32768 MiB VRAM. The running process loaded
the requested canonical model, health returned 200 and a fresh real inference
returned the correct arithmetic result. Recheck live health before listing it.
A lease being active alone does not prove its model is ready.

GPU-B requests one V100, 4 vCPU, 16 GiB RAM and 50 GiB ephemeral storage.
It loads `Qwen/Qwen2.5-3B-Instruct`, uses that canonical served model name,
limits context to 4096 tokens and permits two concurrent model sequences.
The accepted bid is `383.910083 uact` per block. At 600 six-second blocks per
hour, that is approximately USD 0.230346 per hour or USD 5.528305 per day.
Actual billing follows chain blocks. The SDL bid ceiling is 500 uact per block.
The provider advertises city code `NYL`, country `BE`, region `eu-west`.

Model downloads use ephemeral storage and repeat if the container is replaced.
The separately billed API backend uses its own deployment and storage.

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

## Deployment controls

The overnight freeze was superseded by the owner's explicit morning instruction
to add GPU capacity and move the backend to Akash. Inspect real bids and their
resource specifications before accepting a lease. Preserve working deployments
while validating replacements. Keep newly leased nodes out of the serving
catalog until health, hardware, model process and fresh inference checks pass.

AWS GPU capacity is not deployed. Never print keys, seeds, endpoint secrets or
the contents of `.env` while inspecting infrastructure. Use Console secret
references and stdin secret maps instead of literal secrets in an SDL.

# Akash GPU inventory

Live availability requires a passing health check, matching model identity and
measured inference throughput. An accepted lease or a prepared manifest does
not prove capacity. Public receipts in `leases/` contain accepted bids, resource
specifications and verification results. GPU endpoint addresses stay private.

| GPU | Actual hardware | Actual model | Lease | Verification |
| --- | --- | --- | --- | --- |
| A | NVIDIA T4, 16 GB | Qwen2.5-1.5B-Instruct | 1792883508772 | Hardware, inference and physical identity verified |
| B | Tesla V100 PCIe, 32 GB | Qwen2.5-3B-Instruct | 1792936107663 | Hardware, inference and physical identity verified |
| C | Tesla V100 PCIe, 32 GB | Qwen2.5-3B-Instruct | 1792939554118 | Hardware, inference, two throughput samples and physical identity verified |
| D | NVIDIA T4, 16 GB nominal, 15360 MiB usable | Qwen2.5-3B-Instruct | 1792938865934 | Hardware, inference, two throughput samples and physical identity verified |
| E | RTX 3090 requested, not yet verified | Qwen2.5-3B-Instruct requested | 1792940820777 | Image download pending; unavailable |
| F | V100 requested, not yet verified | Qwen2.5-3B-Instruct requested | 1792940870902 | Image download pending; unavailable |
| G | V100 requested, not yet verified | Qwen2.5-3B-Instruct requested | 1792941075797 | Image download pending; unavailable |
| H | Replacement being screened | Unavailable | No replacement lease accepted | Unavailable |

The four verified physical GPU UUID hashes are distinct. Do not describe this
as eight physical GPUs until all eight UUID hashes, health checks and inference
results have been verified. Offline or unmeasured nodes remain hidden from the
serving catalog. `GPU_NODES` enables only verified, measured workers.

GPU-A loads canonical `Qwen/Qwen2.5-1.5B-Instruct` weights. Its historical vLLM
0.6.2 wire alias is `Qwen/Qwen3-1.7B`; the alias does not identify the weights.
GPU-B through GPU-D use canonical `Qwen/Qwen2.5-3B-Instruct` for both weights
and served model name. Their context limit is 4096 tokens with two concurrent
model sequences.

## Resources and prices

GPU-A has 4 vCPU, 16 GiB RAM, 100 GiB ephemeral storage and one T4. Its accepted
bid is 272 uact/block, approximately USD 0.1632/hour. GPU-B and GPU-C each have
4 vCPU, 16 GiB RAM, 50 GiB ephemeral storage and one V100. Each accepted bid is
383.910083 uact/block, approximately USD 0.230346/hour. GPU-D has the same CPU,
RAM and storage sizes and one T4; its bid is 233.188884 uact/block, approximately
USD 0.139913/hour.

The authorized new-node bid ceiling is 500 uact/block per GPU, approximately
USD 0.30/hour. Dollar estimates assume 600 six-second blocks/hour and one
million uact per USD. Actual billing follows chain blocks. Accepted costs and
source timestamps are recorded per lease. Price comparisons use live feeds;
they do not replace the accepted lease cost.

GPU-A advertises city code LIS, country PT, region eu-southwest. GPU-B and
GPU-C advertise NYL, BE, eu-west. GPU-D advertises FAT, US, na-us-west. Provider
attributes are the location source; ingress hostnames are not location proof.

## Failed expansion capacity

Four new ZenCloud V100 leases never served or accepted application tasks.
Each crashed with CUDA out-of-memory while an incumbent process already used
28.02 GiB of the assigned 31.73 GiB device. The containers could not remain
running long enough for UUID inspection, so duplicate UUIDs are not asserted.
The owner authorized closure of these four failed ephemeral leases. All four
were confirmed absent from active inventory. The structured audit is
`leases/failed-expansion-capacity.json`. Working A/B/C/D leases were preserved.
New capacity from that provider is excluded pending investigation.

## Manifests and controls

Files without `-live` are prepared hardware specifications. Their letter and
hardware pairing does not override verified runtime metadata. The P40
specification is not executable with vLLM 0.6.2 because that engine requires
[CUDA compute capability 7.0 or newer](https://raw.githubusercontent.com/vllm-project/vllm/v0.6.2/docs/source/getting_started/installation.rst);
[NVIDIA lists P40 at capability 6.1](https://developer.nvidia.com/cuda/gpus/legacy). Never count it as
serving capacity with this image.

Model weights use ephemeral storage and download again when a container is
replaced. The separately billed API backend has its own deployment and
persistent storage; its audit receipt is `leases/backend.json`.

The owner explicitly authorized the morning capacity expansion. Inspect actual
bids, preserve working deployments, verify physical UUID uniqueness and enable
workers only after hardware, model process, health, fresh inference and two
throughput samples pass. Keep unavailable capacity hidden. Do not print keys,
seeds, GPU endpoint addresses or `.env` contents. GPU SDLs contain only public
model weights and standard image configuration. Backend secrets use native
Console secret references and stdin maps. No AWS GPU deployment is running.

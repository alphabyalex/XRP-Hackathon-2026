# Moonshift AWS GPU runbook

This folder describes the intended AWS setup. It contains no credentials,
account IDs, SSH keys, or secret values. Do not use a root account.

## Target setup

- Region: `us-east-2` (Ohio).
- Instance: `g4dn.xlarge` with one NVIDIA T4 16 GB GPU.
- AMI: a current Ubuntu Deep Learning AMI with NVIDIA drivers already present.
- Storage: 100 GB `gp3` root volume.
- Quota: `Running On-Demand G and VT instances` needs at least four vCPUs per
  worker. Eight vCPUs is required before adding a second real GPU.
- vLLM: bound only to `127.0.0.1:8000` with `float16` and a 4096-token model
  context. Never expose port 8000 publicly.

## Network rules

Create a dedicated security group. Permit SSH only from known team IP ranges.
Permit port 5000 only from the API host's private security group or CIDR. Do
not add a public rule for port 5000 or port 8000. During development, use an
SSH tunnel instead of widening the security group.

## One-time preparation

1. Have the account owner give Kristian a separate IAM identity with the least
   privileges needed for the instance and logs. Never share the root password.
2. Confirm the EC2 quota, then create the instance with the settings above.
3. Authenticate a local AWS CLI profile without putting keys in this repository.
4. On the host, create a Python environment and install
   `services/compute/requirements-gpu.txt` after validating the driver/CUDA
   pairing.
5. Start vLLM on `127.0.0.1:8000`, then start the compute router with `MOCK=0`
   and its process environment supplied by the host's secret manager or local
   environment.
6. Benchmark the actual T4, update the throughput environment variables, and
   test a booking transition before allowing public demo traffic.

## Start and stop

Both scripts operate only on an existing instance identified by an environment
variable. They write an untracked UTC start/stop line to `infra/.state/hours.csv`
for a simple running-hours log.

```bash
export AWS_PROFILE=moonshift-kristian
export AWS_REGION=us-east-2
export MS_INSTANCE_ID=i-REPLACE_WITH_EXISTING_INSTANCE_ID
./infra/start.sh
# Use the worker, then stop it promptly.
./infra/stop.sh
```

The scripts are intentionally not run by this project. Review the selected
instance ID before each use. Stop the instance whenever it is idle to avoid
unnecessary cost.

## Required real-GPU evidence before the demo

Record, with timestamp and model version:

- sustained tokens per second;
- time to first token;
- p50 and p95 latency for a 256-token answer;
- observed drain time when a future booking starts;
- the exact vLLM version and AMI/driver combination.

Do not describe mock measurements as real GPU measurements.

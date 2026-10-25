# Akash backend release

The backend uses one CPU deployment with a persistent 20 GiB volume. Only the
Express API port is public. Compute, pricing, risk, credit and router listen on
loopback. The two GPU leases are separate deployments and remain running during
backend updates.

The official Node 24 image is pinned by digest. Bootstrap fetches an exact public
Git commit, installs the lockfile and separate Python environments for each
service. Python environments are isolated by release revision for rollback.
The complete backend restarts if a child fails. Process groups are stopped with
the API first. A persistent volume lock prevents overlapping backend writers.

## Prepare and inspect bids

Commit, validate and push the release to `tharun` before running bootstrap.
Set both GPU endpoints and their verified hardware, canonical model and accepted
lease price in the gitignored local `.env`. Never print that file.

```bash
python3 infra/akash/backend/prepare.py --revision FULL_COMMIT_SHA --create
akt console deployment list -o json
akt console bid list BACKEND_DSEQ -o json
```

Check the actual CLI help for the current bid command. Creation opens an order;
it does not accept a provider. The SDL cap is 50 uact per block, approximately
$0.03/hour at 600 blocks/hour. Inspect the real bid before accepting it. No AWS
compute or paid Bedrock calls are enabled by this deployment.

Runtime credentials are allowlisted and supplied through Console native secret
references, using stdin. Akash management and AWS credentials are excluded.
The existing account encryption key is preserved. Public backend operator keys
are generated separately. Private operational artifacts live under
`~/.local/state/moonshift/backend`, with directory mode 0700 and file mode 0600.
Do not commit or share those artifacts.

## Transfer state and activate

The new container waits without starting any service until migration completes.
Drain running router orders and stop the previous backend process tree first.
The snapshot tool refuses to run while a backend listener remains active.

```bash
python3 infra/akash/backend/snapshot.py --source-stopped
MOONSHIFT_SNAPSHOT_BYTES=$(wc -c < PRIVATE_SNAPSHOT_PATH | tr -d ' ')
akt console shell BACKEND_DSEQ backend --stdin -- /bin/sh -ec \
  "umask 077; head -c $MOONSHIFT_SNAPSHOT_BYTES | tar -xz -C /data" < PRIVATE_SNAPSHOT_PATH
akt console shell BACKEND_DSEQ backend -- /bin/sh -ec \
  'test -f /data/state/migration.json && touch /data/state/ACTIVATE'
```

SQLite's backup API includes committed WAL records and checks database integrity.
The bounded input is required by akt 1.0.4: its provider shell forwards the bytes
but does not deliver stdin EOF. An unbounded gzip/tar pipeline can wait forever
without extracting its final records. Always verify the manifest hashes after
transfer and before activation.
The archive contains the API, router and credit databases, compute/risk state and
current public account, lending and collateral registries. It preserves the
local collateral records, wallet sessions and encrypted account seeds. Existing
state is never reset. An integrity manifest is verified before any writer starts.

Verify the API health, both catalog GPUs, both serving models, AWS timestamps and
a small DEV task on each model. Verify settlement before connecting Vercel.
Keep the stopped laptop snapshot available for rollback. Before switching back,
stop the cloud writer and copy its latest state back; do not boot both writers.

Persistent storage survives container restarts. Closing a lease is a separate
destructive action and is not part of this release workflow. Back up mutable
state before any provider migration or lease closure.

SDL storage syntax follows the official
[Akash persistent storage reference](https://akash.network/docs/developers/deployment/akash-sdl/advanced-features/).

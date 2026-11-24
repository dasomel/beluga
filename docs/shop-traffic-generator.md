# Shop CDC traffic generator

English | [한국어](shop-traffic-generator-ko.md)

Alongside the clickstream generator, `Deployment/database/shop-gen` continuously
writes synthetic shop data through Postgres → Debezium → Kafka → Flink → Iceberg.
Static/unit checks cover the declared behavior; runtime installation, CNPG role
reconciliation, Cilium enforcement and end-to-end propagation remain unverified live.

`shopGenerator.enabled` defaults to **false** (D-SHOP-8): upgrading an existing
cluster by auto-sync adds no generator workload, role or grants dependency.
When enabled, it commits one write every 3 seconds and logs every 20 writes.
The order cap defaults to 1,000, with at most one extra row to allow CDC deletes;
customer inserts stop at 100. Every ten ticks, one oldest generator-owned order is
deleted only if the total exceeds the cap. Lowering the cap drains owned excess
at that rate; seed/unowned rows are never deleted, even if they alone exceed it.
The optional grants hook adds `orders.generator_owned` (default false) idempotently;
generator INSERTs set it true (D-SHOP-11), retaining ownership across restarts and
updates without changing business status values. Other writers must leave it false. Existing excess customers remain because
orders may reference them. Other writers are outside these bounds. Use synthetic data.

D-SHOP-1/2 serialize writes with a transaction advisory lock and use database counts
rather than local IDs; restart needs no seed/reset. The single replica uses Recreate.
D-SHOP-3 retries DB outages, missing schema and asynchronous credential/grant setup
with capped exponential backoff, then exits 1 after seven consecutive failures
so `ContainerRestartingFrequently` can report persistent failures. Invalid numeric configuration exits 2. Error logs
omit connection diagnostics and secrets. Script checksums trigger rollout on changes.
Runtime pip installation retries with backoff, using pinned `psycopg2-binary==2.9.10`
in a bounded emptyDir on the existing `python:3.12-slim` image. These are version pins,
not verified package hashes or image digests. D-SHOP-5 reserves 32Mi ephemeral storage
and limits it to 384Mi (32Mi libraries + 128Mi temporary files + 224Mi logs/layer),
without claiming measured consumption.

D-SHOP-4 follows the Manager DB pattern: bootstrap generates a password once in
`beluga-credentials` and projects only `shop-generator-db` into `database`. CNPG
manages `shop_generator` (LOGIN, NOINHERIT, two connections); the existing owner-run
`db-roles-setup` hook waits at most 60 attempts with 5s sleeps (plus bounded DB
query time). D-SHOP-9 logs and skips optional grants if the role is missing or the
grant fails; shared platform sync still succeeds. D-SHOP-12 excludes the optional Deployment
from ArgoCD health gating so connection failures cannot hold later sync waves.
Inspect generator logs/restart alerts separately (a missing Secret prevents startup
and does not produce container restarts). It grants CONNECT, schema USAGE, DML on
only `public.orders`/`public.customers`, and USAGE on their two serial sequences.
D-SHOP-10 uses `PGSSLMODE=verify-full` and mounts only `ca.crt` from the
same-namespace CNPG `postgres-main-ca` Secret; no copying or new RBAC is needed.
The runtime never receives owner credentials or cluster RBAC. Compiled human-policy
SQL is unchanged. Disabling the generator removes its workload/policies and desired
CNPG role entry; it deliberately does not delete the stored role, grants or Secret.

D-SHOP-6 adds only DB TCP 5432 ingress from the generator, without enabling a new
DB default-deny: this checkout has no such database ingress baseline. Cilium egress
restricts the generator to Postgres TCP 5432, cluster DNS, and HTTPS to `pypi.org` /
`files.pythonhosted.org`. Cilium CRDs/FQDN DNS proxy support are required. This is
not a claim that all existing DB clients are ingress-isolated.

To opt in, first provision the Secret (use the isolated lab kubeconfig below;
Colima users follow [its kubeconfig instructions](colima-single-node.md)):

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash scripts/gitops/01-argocd-bootstrap.sh --shop-generator-secrets-only
```

Then set `shopGenerator.enabled: true` in `gitops/values/shop-generator-lab.yaml`,
loaded by the Vagrant/Colima lab Application `gitops/apps/beluga-data.yaml`.
The `gitops/profiles/full/Kustomization` overlay inherits that Application and adds
`gitops/values/profile-full.yaml`; that shared full-profile file is also used by
Kakao, so do not enable the generator there. Kakao's independent Application
(`csp/kakao-cloud/gitops/apps/beluga-data.yaml`) stays default-off.
Submit the lab values change through normal GitOps review/sync.
After CNPG creates the role, trigger a **full** sync with
`argocd app sync beluga-data` (or Sync in the UI with no resource selection).
The hook reruns on every full sync and reapplies grants idempotently; selective
resource sync skips hooks. No manual SQL grants are needed.

Full bootstrap also provisions it. The secrets-only mode needs existing
`platform-system/beluga-credentials` and the `database` namespace. It preserves an
existing Secret; password rotation is a separate operation.

Run these checks after the operator has synced the chart through ArgoCD:

```bash
kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
kubectl -n database rollout status deployment/shop-gen --timeout=180s
kubectl -n database logs deployment/shop-gen --tail=50
bash tests/02-ingest-cdc.sh
bash tests/03-stream-iceberg.sh
bash tests/04-trino-query.sh
```

Those existing tests are smoke checks, not proof of continuous c/u/d convergence.
For a stronger source check, take two generator-authenticated snapshots at least
60 seconds apart and verify the limit and changing values:

```bash
kubectl -n database exec deployment/shop-gen -- python -c 'import psycopg2; c=psycopg2.connect(); q=c.cursor(); q.execute("SELECT count(*), min(order_id), max(order_id), max(updated_at) FROM public.orders"); print(q.fetchone()); q.execute("SELECT count(*), max(customer_id) FROM public.customers"); print(q.fetchone())'
```

Also verify the service login cannot create tables/read other application tables,
inspect Debezium records for `op=c/u/d`, and compare the actual order/customer IDs
and values in Iceberg using operator Trino credentials. Neither smoke success nor
source snapshots alone prove delete propagation, least privilege, or Cilium denies.

Synthetic email domains are derived from `baseDomain`; an empty domain or one longer than 67 characters is rejected to fit the existing email column.

To disable, set the lab value to false and sync with pruning; wait for `database/shop-gen`
to disappear. The role, grants, Secret and ownership column remain. For optional credential/role cleanup,
after that sync completes, run with the isolated kubeconfig and existing owner access:

```bash
kubectl -n database exec postgres-main-1 -- psql -U postgres -d shop -v ON_ERROR_STOP=1 -c 'DROP OWNED BY shop_generator; DROP ROLE shop_generator;'
kubectl -n database delete secret shop-generator-db
kubectl -n platform-system patch secret beluga-credentials --type=json -p='[{"op":"remove","path":"/data/shop-generator-password"}]'
```

`DROP OWNED` revokes this login's grants; the generator creates no database objects.
The last command removes the saved password so the secrets-only step can recreate it.
Do not run cleanup while the managed role is still declared present.

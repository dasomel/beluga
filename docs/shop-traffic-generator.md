# Shop CDC traffic generator

English | [한국어](shop-traffic-generator-ko.md)

Alongside the clickstream generator, `Deployment/database/shop-gen` continuously
writes synthetic shop data through Postgres → Debezium → Kafka → Flink → Iceberg.
Static/unit checks cover the declared behavior; runtime installation, CNPG role
reconciliation, Cilium enforcement and end-to-end propagation remain unverified live.

`shopGenerator` in `gitops/charts/beluga-data/values.yaml` defaults to enabled,
one committed write every 3 seconds, at most 1,000 orders and 100 customers, and
one progress log per 20 writes. Each ten-tick cycle mixes order inserts, status/amount
updates, deletion of the oldest order, and customer inserts/updates. At the order
cap, deletion takes priority. Lowering the order cap drains excess rows one per
tick; customer inserts stop at their cap (existing excess customers are retained
because orders may reference them). These bounds cover this generator, not other
writers. It mutates the demo tables, including seed rows; use only synthetic data.

D-SHOP-1/2 serialize writes with a transaction advisory lock and use database counts
rather than local IDs; restart needs no seed/reset. The single replica uses Recreate.
D-SHOP-3 retries DB outages, missing schema and asynchronous credential/grant setup
with capped exponential backoff. Invalid numeric configuration exits 2. Error logs
omit connection diagnostics and secrets. Script checksums trigger rollout on changes.
Runtime pip installation retries with backoff, using pinned `psycopg2-binary==2.9.10`
in a bounded emptyDir on the existing `python:3.12-slim` image. These are version pins,
not verified package hashes or image digests. D-SHOP-5 reserves 32Mi ephemeral storage
and limits it to 384Mi (32Mi libraries + 128Mi temporary files + 224Mi logs/layer),
without claiming measured consumption.

D-SHOP-4 follows the Manager DB pattern: bootstrap generates a password once in
`beluga-credentials` and projects only `shop-generator-db` into `database`. CNPG
manages `shop_generator` (LOGIN, NOINHERIT, two connections); the existing owner-run
`db-roles-setup` hook waits for that role and grants CONNECT, schema USAGE, DML on
only `public.orders`/`public.customers`, and USAGE on their two serial sequences.
The runtime never receives owner credentials or cluster RBAC. Compiled human-policy
SQL is unchanged. Disabling the generator removes its workload/policies and desired
CNPG role entry; it deliberately does not delete the stored role, grants or Secret.

D-SHOP-6 adds only DB TCP 5432 ingress from the generator, without enabling a new
DB default-deny: this checkout has no such database ingress baseline. Cilium egress
restricts the generator to Postgres TCP 5432, cluster DNS, and HTTPS to `pypi.org` /
`files.pythonhosted.org`. Cilium CRDs/FQDN DNS proxy support are required. This is
not a claim that all existing DB clients are ingress-isolated.

For an existing cluster, provision the Secret before syncing the reviewed chart:

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash scripts/gitops/01-argocd-bootstrap.sh --shop-generator-secrets-only
```

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

# Beluga dbt project — Phase A / Phase B

dbt Core models SQL transformations; Trino executes them and the Phase B Airflow
DAG orchestrates them. [ADR-0007](../docs/adr/0007-dbt-core-transformation-layer.md) records
the decisions. Phase A checks run only against synthetic local DuckDB fixtures.
They do not enable DuckDB production writes under ADR-0004.

## Local checks

Use Python 3.12. From the repository root, install both pre-generated hash locks
(the Trino adapter is required even for offline `parse`; no lock regeneration):

```bash
python3.12 -m venv .venv-dbt
.venv-dbt/bin/python -m pip install --require-hashes -r requirements-dbt-ci.txt -r images/dbt/requirements.txt
DBT_BIN=.venv-dbt/bin/dbt make dbt-check
cd dbt
DBT_SEND_ANONYMOUS_USAGE_STATS=False ../.venv-dbt/bin/dbt docs generate --target ci
```

Dependency installation needs package access or a populated cache. After installation,
the check requires no network: no dbt packages/extensions or live services are used.
Anonymous usage statistics are disabled in project flags, the checker and runtime.
Open `target/index.html` with dbt docs tooling. Outputs and local databases are ignored.
`DBT_BIN` is a single executable path/name, default `dbt`.

## Layers and metrics

- `source('lake', 'orders')`: `iceberg.lake.orders` on Trino; on CI only, a typed
  synthetic seed in local `fixtures`. No `lake.customers` or PII customer attributes.
- `silver_shop.orders`: full table rebuild (D-DBT-7), typed columns, trimmed lower-case
  status, latest `updated_at` per `order_id`. Ties use descending customer ID, amount
  and normalized status, nulls last. Full scans trade efficiency for portability.
- `gold_shop.daily_revenue`: latest order states by **last update date**, since no
  purchase timestamp exists. `order_count` includes every status;
  `completed_order_count` and `completed_revenue` include only completed orders.
  Pending/cancelled contribute zero revenue. This is not historical booked sales:
  updates can move an order between dates. Revenue uses decimal amounts.

Custom schemas are used verbatim, without a target prefix. Runtime seeds and the
expected-value CI test are disabled on Trino. The CI fixture includes repeated order
updates, mixed-case/space-padded statuses, and completed/pending/cancelled orders.

## Publication gate

Always use `dbt build`. Critical uniqueness, not-null, accepted-status and non-negative
amount/revenue tests use severity `error`. Advisory tests may explicitly use `warn`.
The checker runs `deps` (no packages), a positive build including exact Gold assertions,
an isolated negative build, then offline `parse --target trino` using a dummy JWT.
It requires the invalid-status test to fail and Gold to be **skipped**, not merely a
nonzero exit. Evidence stays in `target/run_results.json`,
`target/gate-negative/run_results.json`, and `target/parse-trino/manifest.json`, with
per-command logs alongside them. The positive database is preserved for docs generation.

To reproduce the failure manually (after seeding/building the valid case):

```bash
DBT_CI_PATH=target/manual-negative.duckdb ../.venv-dbt/bin/dbt build --target ci --target-path target/manual-negative --vars '{"gate_negative": true}'
```

The negative switch affects only CI source selection. No live token is needed for
local CI. The checked-in Trino profile reads host/port/scheme/user from `DBT_TRINO_*`
and its token from `DBT_ENV_SECRET_TRINO_JWT` (required, no credential default).
The default endpoint is `https://trino.analytics.svc.cluster.local:8443`, catalog
`iceberg`. Phase B token delivery and CA trust are configured by the DAG below.
Parsing proves neither SQL execution nor authenticated connectivity.

`dbt build` skips downstream execution on upstream test failure; it does not roll
back a model that failed its own tests or provide atomic candidate publication.
An existing Gold table remains when skipped. OD-TR-6 publication isolation is separate.

## Phase B run (live cluster only)

`dbt_shop_medallion` runs daily, initially paused, with one active run and no task
retries. Its KubernetesPodOperator creates a pod in `analytics`, fetches a
client-credentials token over the in-cluster Keycloak endpoint, then replaces Python
with `dbt build --target trino --project-dir /opt/beluga/dbt`. The image is the
published sha-77088d608c4cd21435eb56a9fcf8959191ef401c tag pinned to index digest
sha256:a5ae9732cf08bb5b1e39b74fd12088b39c0efa50e20dab075c3666f7bc28c381.

Prerequisites: the identity lane deploys client `dbt`, its `trino` audience and
`preferred_username=svc-dbt` claims, LDAP user `svc-dbt` in `transformers`, and
`analytics/keycloak-dbt-client-secret` key `dbt`. The policy lane grants only the
reviewed output operations and SELECT on `iceberg.lake.orders`. The existing CA
sync must create `analytics/beluga-internal-ca` key `ca.crt`. The pod mounts it
read-only. Rebuild the dbt image with this project/profile, then update the DAG to
pass `DBT_TRINO_CERT=/etc/internal-ca/ca.crt` alongside `REQUESTS_CA_BUNDLE` and
`SSL_CERT_FILE`. dbt-trino passes `cert` directly as its TLS verification setting;
`REQUESTS_CA_BUNDLE` alone did not enable verification. The project enables
`require_certificate_validation`; `cert` defaults to boolean `true` (system trust)
and accepts a CA bundle path via `DBT_TRINO_CERT`. Never set it to `false`.
The image pin bump and DAG environment update are follow-up deployment work. Token acquisition uses internal HTTP as designed;
the Trino data connection uses internal HTTPS 8443. Tokens/secrets are never logged.
A fresh token is obtained per run; refresh during a run is not implemented, so
its configured lifetime must cover the build (task timeout: 30 minutes).

After the orchestrator deploys the combined change through GitOps, explicitly
restart `deployment/airflow-webserver` in `orchestration`: ConfigMap subPath files
do not update in existing pods. Check `airflow dags list-import-errors` before use.
The Kubernetes provider is installed without a version pin at Airflow startup;
validate actual provider parsing on the deployed Airflow 3.3.0 runtime.

With live execution authorized, isolate the kubeconfig, unpause, and trigger:

```bash
kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
kubectl -n orchestration exec deployment/airflow-webserver -c airflow -- airflow dags unpause dbt_shop_medallion
export DBT_RUN_ID="manual__dbt_check_$(date -u +%Y%m%dT%H%M%SZ)"
kubectl -n orchestration exec deployment/airflow-webserver -c airflow -- airflow dags trigger dbt_shop_medallion --run-id "$DBT_RUN_ID"
bash tests/27-dbt-medallion.sh
```

The live-only test requires `DBT_RUN_ID` (also when using `tests/run-all.sh`), waits
up to 15 minutes for that exact run to succeed, and queries the HTTPS gateway as
`svc-dbt`: both output tables must be readable, Gold must contain rows, and
`lake.customers` must return `PERMISSION_DENIED`. It uses `BASE_DOMAIN` (default
`local.beluga.internal`) and an isolated copy of `KUBECONFIG` (default `.kube/config`).
A shorter verification wait does not change the task timeout; rerun the test if the
build is still running. Logs remain in Airflow; completed task pods are deleted.
This verifies a real build/data path and PII denial only when actually run; offline
checks do not establish live identity, policies, network reachability or S3 writes.
Repeat runs, failure gating on live Iceberg, OpenMetadata/lineage ingestion and run
metadata remain integration follow-ups. Evaluate candidate isolation and incremental
MERGE separately; issue #70 remains pending.

## 한국어 안내

Phase A는 합성 DuckDB fixture만 사용한다. 위 두 해시 requirements를 설치한 뒤
루트에서 `DBT_BIN=.venv-dbt/bin/dbt make dbt-check`를 실행한다. 정상 빌드·잘못된
status 실패·Gold `skipped`·오프라인 Trino 파싱을 확인하며 실제 서비스에는 연결하지 않는다.
Silver는 주문별 최신 상태, Gold는 최신 수정일 기준 완료 주문 매출이다. 전체 table
재생성으로 시작하며 구매일 매출 이력은 제공하지 않는다. `dbt build`의 하위 실행 차단은
원자적 게시나 롤백이 아니다. Phase B 실행 절차는 위와 같다. 실제 클러스터 검증과 계보 연동은 별도 증거가 필요하다.

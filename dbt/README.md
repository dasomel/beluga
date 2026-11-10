# Beluga dbt project — Phase A

dbt Core models SQL transformations; Trino executes them and Airflow will orchestrate
them in Phase B. [ADR-0007](../docs/adr/0007-dbt-core-transformation-layer.md) records
the decisions. This phase runs only against synthetic local DuckDB fixtures. It does
not enable DuckDB production writes under ADR-0004.

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
`iceberg`. Real token delivery and CA trust are Phase B work. Parsing proves neither
SQL execution nor authenticated connectivity.

`dbt build` skips downstream execution on upstream test failure; it does not roll
back a model that failed its own tests or provide atomic candidate publication.
An existing Gold table remains when skipped. OD-TR-6 publication isolation is separate.

## Phase B follow-up

- Keycloak client-credentials service identity, token refresh/delivery and TLS trust.
- Dedicated transformer group; schema-level policy-compiler grants for output writes,
  SELECT on `lake.orders`, and live denial tests for PII/other namespaces.
- Airflow `KubernetesPodOperator` in `analytics` invoking `dbt build`; reviewed
  operation permissions, retries/backfills, concurrency and colima Iceberg gate evidence.
- Adopt the attested image digest in charts and `VERSIONS.md` with license review.
- OpenMetadata/lineage ingestion and run metadata. Evaluate candidate isolation and
  incremental MERGE separately; issue #70 remains pending.

## 한국어 안내

Phase A는 합성 DuckDB fixture만 사용한다. 위 두 해시 requirements를 설치한 뒤
루트에서 `DBT_BIN=.venv-dbt/bin/dbt make dbt-check`를 실행한다. 정상 빌드·잘못된
status 실패·Gold `skipped`·오프라인 Trino 파싱을 확인하며 실제 서비스에는 연결하지 않는다.
Silver는 주문별 최신 상태, Gold는 최신 수정일 기준 완료 주문 매출이다. 전체 table
재생성으로 시작하며 구매일 매출 이력은 제공하지 않는다. `dbt build`의 하위 실행 차단은
원자적 게시나 롤백이 아니다. 인증·권한·DAG·차트·라이브 검증·계보는 명시적 Phase B 후속이다.

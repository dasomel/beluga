# 데이터 라이프사이클 정책 (제안)

[English](data-lifecycle-policy.md) | 한국어

이슈 #18 ("Define data retention, purge, and Iceberg lifecycle policies") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 이 문서는 매니페스트, DAG, 설정을 변경하지 않는다. 아래 모든 값은
> (a) 출처(`[S#]`, [출처](#출처) 참고, 접근일 2026-10-07)가 있는 업스트림 기본값 또는 문서화된 예시이거나,
> (b) 명시적으로 **"공식 권고 없음(NOR)"** 으로 표시하고 소유자 결정으로 남긴다. Beluga의 현재 값은 이 문서를 작성한 시점의
> 저장소에서 직접 확인한 값이다. 소유자는 어떤 제안도 재정의할 수 있으며, 소유자가 정해야 할 값은
> [소유자 결정 사항](#소유자-결정-사항)에 모았다.

컴포넌트 버전은 [`VERSIONS.md`](../VERSIONS.md)를 따른다: Kafka 4.3.0 (Strimzi 1.1.0), Debezium 3.6.1.Final,
PostgreSQL 17.6 (CNPG 1.30.0), SeaweedFS 4.41, Lakekeeper v0.13.1, Flink 1.20.0, Trino 483, Airflow 3.3.0, OpenMetadata 1.13.3.
버전별 문서가 있는 경우 해당 버전을 읽었다 (Kafka 4.3, Trino 483, PostgreSQL 17, Flink 1.20, CNPG v1.30.0, Lakekeeper v0.13.1 태그).
Iceberg, OpenMetadata, SeaweedFS는 버전 없는 `latest` 문서이므로 구현 전에 고정 버전에 맞춰 재확인한다.

## 1. 보존 등급 (Retention classes)

등급은 이슈 #18이 요구한 것이다. "기간"은 의도적으로 채우지 않았다. 업스트림 어느 프로젝트도 업무상 보존 기간을 권고하지 않으므로
숫자는 소유자 결정(D1, D11)이다. [`policies/data-standards.yaml`](../policies/data-standards.yaml)에 이미 선언된 목표
(customers/orders `P365D`, `events_enriched` `P90D`)는 목표일 뿐이며, [`data-standards-ko.md`](data-standards-ko.md)가 밝히듯 물리적 강제를 뜻하지 않는다.

| 등급 | 의미 | Beluga 저장소 | 삭제 트리거 |
|---|---|---|---|
| raw | 수집/랜딩 사본, 원천에서 재생 가능 | Kafka CDC/클릭스트림 토픽, Iceberg `raw/` prefix | 경과 시간/크기 |
| curated | 분석용 관리 테이블 | Iceberg `curated/` 및 `lake.*` 테이블, 카탈로그 + OpenMetadata 메타데이터 | 정책 기간 또는 승인된 purge |
| temporary | 스크래치, 재작성, 체크포인트 | `tmp/` prefix, Flink 체크포인트 | 경과 시간, 자동 |
| audit | 접근/변경/purge 증적 | PostgreSQL 로그(pgaudit 미배포), purge 감사 기록 | 고정 기간, 법적 보존(hold) 고려 |
| backup | 복구용 사본 | CNPG Barman 베이스 백업 + WAL (SeaweedFS `beluga-postgres-backups`) | 백업 보존 기간 |

prefix 규약(`raw/`, `curated/`, `tmp/`)은 `12-lakekeeper-bootstrap.yaml`에서 온다. 현재는 문서상 규약일 뿐이고
SeaweedFS identities는 prefix 단위가 아니라 버킷 단위이다(같은 파일 헤더 주석).

## 2. 정책 매트릭스: 등급 x 저장소

열 설명: **업스트림 값**은 출처가 있는 기본값/예시(명시적 권고가 아닌 한 권고가 아님), **제안**은 소유자가 채택하도록 이 문서가 제안하는 값,
**Beluga 현재**는 저장소에서 확인한 값, **설정 키**는 구현 수단이다. "NOR" = "공식 권고 없음".

### 2.1 Kafka (Strimzi, Kafka 4.3.0)

| 등급 | 설정 | 업스트림 값 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| raw (CDC/클릭스트림) | 시간 보존 | `retention.ms` 기본 604800000 (7일) | S1 | D1에서 달리 정하지 않으면 업스트림 기본값 유지. CDC 전용 기간은 NOR | 미설정. `KafkaTopic` CR 없음. 토픽은 Debezium/프로듀서가 브로커 기본값으로 자동 생성 (`03-strimzi-kafka.yaml`에 `log.retention.*` 없음) | 명시적/선언적이지 않음 | `KafkaTopic.spec.config.retention.ms` [S24] (또는 브로커 `log.retention.hours`, 기본 168 [S2]) |
| raw | 크기 보존 | `retention.bytes` 기본 -1 (무제한, 파티션 단위) | S1 | NOR. 디스크 제약이 있으면 소유자가 파티션당 상한 지정 | 미설정 (무제한) | 크기 가드 없음 | `retention.bytes` |
| raw (키 기반 CDC) | 컴팩션 | `cleanup.policy` 기본 `delete`; `compact`는 키별 최신 값 유지; `delete,compact` 가능 | S1 | Debezium은 PostgreSQL 이벤트가 "Kafka 로그 컴팩션과 함께 동작하도록 설계"되었고 삭제 후 tombstone을 발행한다고 하나 정책을 권고하지는 않는다. NOR, D2 참고 | 미설정 (`delete`) | D2가 `delete` 유지면 없음 | `cleanup.policy` |
| raw (컴팩션) | 컴팩션 튜닝 | `min.cleanable.dirty.ratio` 0.5; `delete.retention.ms` 86400000 (1일); `min.compaction.lag.ms` 0; `segment.ms` 604800000 | S1 | D2가 compact일 때만 해당. 업스트림은 `delete.retention.ms`가 offset 0부터 읽기 시작한 컨슈머가 tombstone 소멸 전에 읽기를 끝내야 하는 시간 한도라고 설명. 숫자는 NOR | 미설정 | 해당 없음 | 동일 키 |
| 전체 | 보존 점검 주기 | `log.retention.check.interval.ms` 300000 (5분) | S2 | 기본 유지 | 기본값 | 없음 | 브로커 설정 |
| 컨슈머 | 오프셋 | `offsets.retention.minutes` 10080 (7일) | S2 | 기본 유지 | 기본값 | 없음 | 브로커 설정 |

참고: Debezium 토픽 자동 생성은 커넥터별로 `topic.creation.default.cleanup.policy` / `retention.ms`를 지정할 수 있다 [S23]. 현재 `shop-cdc` 커넥터
(`03-strimzi-kafka.yaml`, `topic.prefix: cdc.shop`)는 아무것도 지정하지 않는다. 복제 계수는 전부 1(`default.replication.factor: 1`)이므로
이 단일 브로커 프로파일에서 Kafka 보존은 내구성 보장이 아니다.

### 2.2 Iceberg 테이블 (Trino 483 + Airflow DAG, 카탈로그는 Lakekeeper v0.13.1)

| 등급 | 설정 | 업스트림 값 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| curated/raw | 스냅샷 만료 기간 | 테이블 기본 `history.expire.max-snapshot-age-ms` = 432000000 (5일); Spark 프로시저 `older_than` 기본 5일; Trino `retention_threshold`는 `iceberg.expire-snapshots.min-retention`(기본 `7d`) 이상이어야 함 | S4, S5, S6 | 7일 유지: Trino 카탈로그 최소값이자 기존 DAG 값. 더 길게는 소유자 판단(D3). Iceberg는 "스냅샷을 정기적으로 만료할 것을 권장" | `iceberg_maintenance` DAG, 매시간: **`events_enriched`만** `expire_snapshots(retention_threshold => '7d')` (`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`) | `customers`, `orders`는 만료되지 않음 | `ALTER TABLE ... EXECUTE expire_snapshots(retention_threshold => '7d')` 또는 테이블 속성 `history.expire.max-snapshot-age-ms` |
| curated | 최소 보존 스냅샷 수 | `history.expire.min-snapshots-to-keep` 기본 1; `retain_last` 기본 1 (Trino, Spark 공통) | S4, S5, S6 | 더 큰 숫자는 NOR (D3) | 미설정 (기본 1) | 복구 기간이 시간 기준뿐 | `retain_last` / `history.expire.min-snapshots-to-keep` |
| curated | 고아 파일 제거 | Iceberg `older_than` 기본 3일; Trino `retention_threshold`는 `iceberg.remove-orphan-files.min-retention`(기본 `7d`) 이상; Lakekeeper `default-older-than-ms` 604800000 (7일), 24시간 하한 | S3, S5, S6, S7 | 7일 사용 (Trino/Lakekeeper 기본, Iceberg 3일보다 안전). 만료 후 실행(S7) | **저장소 어디에도 `remove_orphan_files` 없음** (`gitops/ docs/ tests/ scripts/` grep) | 실패한 쓰기의 고아 파일 누적 | `ALTER TABLE ... EXECUTE remove_orphan_files(retention_threshold => '7d')` |
| curated | 메타데이터 파일 정리 | `write.metadata.delete-after-commit.enabled` 기본 false; `write.metadata.previous-versions-max` 기본 100 (Iceberg). Lakekeeper: v0.10.0부터 delete-after-commit 기본 활성, 현재 + 최대 previous-versions-max개 유지 | S4, S7 | Lakekeeper(v0.13.1) 동작 유지. 추적되지 않는 메타데이터 파일은 고아 파일 제거 필요(S3) | 테이블별 미설정, Lakekeeper 기본 적용 | 없음 (고아 파일 작업이 커버) | 위 테이블 속성 |
| curated | 소파일/매니페스트 컴팩션 | Iceberg는 컴팩션과 매니페스트 재작성을 선택적 유지보수로 분류 | S3 | 주기는 NOR | DAG가 `events_enriched`, `orders`에 Trino `optimize`를 매시간 실행 | `customers` 미컴팩션 | `ALTER TABLE ... EXECUTE optimize` |
| curated | 스냅샷 ref (tag/branch) | `history.expire.max-ref-age-ms` 기본 `Long.MAX_VALUE` (영구); `main`은 만료 안 됨 | S4 | 법적 보존(legal hold) 수단으로 tag 사용 (4절 참고) | 미사용 | 해당 없음 | `history.expire.max-ref-age-ms` |
| curated | 카탈로그 측 자동 만료/고아 큐 | Lakekeeper `enable-expire-snapshots` 기본 false; `enable-remove-orphan-files` 기본 false; 둘 다 "Lakekeeper Plus" 배지가 붙어 있고 Plus는 라이선스 필요 | S7, S10 | Apache-2.0 이미지(VERSIONS.md)에서는 의존하지 않고 Trino/Airflow를 실행 주체로 유지. 변경 전 확인 | 미설정 | 해당 없음 | `/management/v1/warehouse/{id}/task-queue/{expire_snapshots,remove_orphan_files}/config` |
| curated | 삭제된 테이블 soft deletion | Lakekeeper 웨어하우스 soft deletion: drop된 테이블은 drop 시점에 고정되는 만료 지연까지 복구 가능. 기본 지연은 읽은 페이지에 명시 없음. `push-s3-delete-disabled` 기본 true | S8, S9 | 지연은 NOR (D7). 3절 불변식 참고 | 부트스트랩 웨어하우스 payload에 soft deletion 설정 없음 (`12-lakekeeper-bootstrap.yaml`) | drop된 테이블은 soft delete되지 않음 | 웨어하우스 `delete-profile` (정확한 키는 읽은 페이지에 없음. v0.13.1 management OpenAPI에서 확인) |
| temporary | 재작성/스크래치 데이터 | `tmp/` prefix에 대한 Iceberg 지침 없음 | 해당 없음 | NOR. 오브젝트 스토리지 행 참고 | `tmp/`는 문서상 규약뿐 | 만료 없음 | S3 lifecycle (2.3) |
| curated | 정리 작업의 가드 | Trino는 설정된 최소값보다 짧은 임계값을 거부 | S6 | 두 `min-retention`을 낮추지 않는다 (불변식의 강제 수단) | 둘 다 기본 `7d` (`06-trino.yaml`에 설정 없음) | 없음 | `iceberg.expire-snapshots.min-retention`, `iceberg.remove-orphan-files.min-retention` |

### 2.3 오브젝트 스토리지 (SeaweedFS 4.41)

| 등급 | 설정 | 업스트림 기능 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| temporary | prefix 만료 | S3 `PutBucketLifecycleConfiguration` 지원 (`Expiration.Days/Date`, `NoncurrentVersionExpiration`, `AbortIncompleteMultipartUpload`, prefix/tag/크기 필터). **Transition 규칙은 거부됨** (스토리지 클래스 없음) | S12, S14 | `tmp/`와 미완료 멀티파트 업로드에만 사용. 일수는 NOR (D6) | lifecycle 설정 없음 | 스크래치/멀티파트 정리 없음 | `beluga-lake` 버킷 lifecycle |
| curated/raw | 테이블 데이터 | Iceberg 테이블 데이터를 버킷 lifecycle로 만료시키면 **안 된다** (Beluga 설계 규칙이며 업스트림 서술이 아님): 오브젝트는 스냅샷이 참조하며 Iceberg expire/orphan 작업으로만 제거 | 해당 없음 | `raw/`, `curated/`에 매칭되는 lifecycle 규칙이 없음을 검증하는 테스트 추가 | 없음 | 해당 없음 | 해당 없음 |
| backup | 백업 버킷 | 같은 API. CNPG가 자체 보존 정책으로 오래된 백업을 삭제 (2.5 참고). 버킷 규칙이 그보다 짧으면 안 됨 (Beluga 설계 규칙) | S12, S19 | 버킷 규칙 없음. CNPG가 유일한 삭제 주체 | 없음 | 해당 없음 | 해당 없음 |
| audit/backup | 불변성 | S3 Object Lock 지원: Governance/Compliance 모드, `Get/PutObjectRetention`, legal hold | S13 | 백업/감사 버킷 및 legal hold 후보. **전제 조건: Object Lock은 버킷 생성 시에만 켤 수 있고 나중에 추가할 수 없다 [S13]. 기존 `beluga-postgres-backups` 버킷은 Object Lock을 켜고 새로 만든 버킷으로 마이그레이션해야 한다** (버저닝은 자동 활성화 [S13]: 일반 삭제는 delete marker만 추가하고 이전 버전이 남아 non-current 버전을 만료시키지 않으면 사용량이 계속 늘어남, 백업 보존 행과 테스트 참고). 모드 선택 필요 (D10). 4.41에서 미검증이므로 테스트 대상으로 취급 | 비활성 | WORM 없음 | 버킷 Object Lock |
| 전체 | SeaweedFS 자체 TTL | 볼륨 TTL (`?ttl=3m`) 및 `fs.configure -ttl`로 파일별 TTL | S15 | 테이블 데이터에는 권장하지 않음 (위와 같은 이유) | 미사용 | 해당 없음 | 해당 없음 |

### 2.4 Flink 체크포인트 (Flink 1.20.0)

| 등급 | 설정 | 업스트림 값 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| temporary | 보존 완료 체크포인트 수 | `execution.checkpointing.num-retained` 기본 1 | S11 | 다른 숫자는 NOR (D8). 이전 체크포인트 복원이 필요하지 않으면 1 유지 | 미설정 (기본값). `execution.checkpointing.interval: 30s`, `mode: EXACTLY_ONCE`만 있음 (`05-flink-operator.yaml`, `flink-sql/*.sql`) | 기능상 없음 | `execution.checkpointing.num-retained` |
| temporary | 취소 시 externalized 보존 | `execution.checkpointing.externalized-checkpoint-retention` 기본 `NO_EXTERNALIZED_CHECKPOINTS`; 그 외 `DELETE_ON_CANCELLATION`, `RETAIN_ON_CANCELLATION`; 문서는 보존된 externalized 체크포인트를 수동 정리해야 한다고 경고 | S11 | NOR. `RETAIN_ON_CANCELLATION` 선택 시 정리 작업 필요 (D8) | 미설정. `execution.checkpointing.dir`도 없음 (기본 none) | 체크포인트 저장 경로가 저장소에 선언되지 않음 | 동일 키 + `execution.checkpointing.dir` |

Iceberg 싱크는 체크포인트 시점에만 커밋한다 (`05-flink-operator.yaml` 주석). 따라서 체크포인트 주기와 커밋 시간이 3절의 고아 파일 연령 불변식에 영향을 준다.

### 2.5 PostgreSQL (CNPG 1.30.0 / PostgreSQL 17.6)

| 등급 | 설정 | 업스트림 값 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| backup | 백업 보존 | CNPG 1.30 문서: `spec.backup.retentionPolicy`는 **deprecated**이며 제거 예정. 백업 플러그인(Barman Cloud plugin)의 보존 기능 사용. 기본 기간 명시 없음 | S19 | D10 전까지 30일 유지, 플러그인 보존으로 이전 계획 버킷을 Object Lock/버저닝으로 옮기면(2.3 참고) `NoncurrentVersionExpiration`(및 `ExpiredObjectDeleteMarker`) lifecycle 규칙을 추가하되 일수는 Object Lock 보존 기간보다 짧지 않게 한다 [S12]. 버저닝 버킷에서 CNPG의 삭제는 delete marker만 추가하기 때문이다 (S13/S12에서 추론, 테스트 필요). | `retentionPolicy: "30d"` + 일일 `ScheduledBackup` `0 0 2 * * *` + WAL 아카이브 (`02-cnpg.yaml`) | deprecated 필드 사용 | 플러그인 보존 (S19 참고) |
| audit | pgaudit 보존 | pgAudit은 표준 PostgreSQL 로그에 기록하며 README에 보존 설정이 없음 | S18 | 보존 = 로그 로테이션/전송 정책 (확장 기능 밖) | pgaudit 미설정 (`02-cnpg.yaml`) | PostgreSQL 감사 추적 없음 | 해당 없음 |
| audit/운영 | 서버 로그 로테이션 | `log_rotation_age` 기본 24시간; `log_rotation_size` 기본 10MB; `log_truncate_on_rotation`은 7일 예시 문서화 (`log_filename = server_log.%a`, age 1440) | S16 | 7일 예시는 메커니즘 샘플로만 사용. 기간은 NOR (D9) | 미설정 | 해당 없음 | `spec.postgresql.parameters`의 `log_*` |
| audit/운영 | 시간 기반 테이블 정리 | PostgreSQL 문서: 파티션 drop/detach가 대량 `DELETE`보다 훨씬 빠름 | S17 | 큰 감사/운영 테이블은 시간 파티셔닝 후 기간별 drop/detach. 기간은 NOR | 해당 테이블 아직 없음 | 해당 없음 | 선언적 파티셔닝 DDL |

### 2.6 카탈로그 메타데이터 (Lakekeeper, OpenMetadata 1.13.3)

| 등급 | 설정 | 업스트림 동작 | 출처 | 제안 | Beluga 현재 | 격차 | 설정 키 |
|---|---|---|---|---|---|---|---|
| curated | 삭제된 데이터셋이 검색에 남지 않아야 함 (OpenMetadata) | soft delete는 자산을 읽기 전용으로 유지, hard delete는 영구 삭제; soft delete된 자산은 복원 가능. Iceberg 커넥터 옵션 "Mark Deleted Tables"(기본 On): 소스에서 사라진 테이블을 OpenMetadata에서도 soft delete, 에이전트가 스캔하는 스키마에 한함 | S20, S21 | soft delete만으로는 읽기 전용 자산이 남는다. purge에는 hard delete 필요 (D12). soft delete 자산이 검색에서 숨겨지는지는 읽은 페이지에 명시 없음: 테스트로 확인 | 저장소에 OpenMetadata 수집 설정 없음 (`11-openmetadata.yaml`에 삭제 설정 없음) | 정합화(reconciliation) 미정의 | 수집 `markDeletedTables`; API `hardDelete` |
| curated | Lakekeeper 카탈로그 항목 | soft delete된 테이블은 만료까지 유지; soft delete된 하위 객체가 있으면 웨어하우스/네임스페이스를 drop할 수 없음 | S8 | purge 절차 순서에 포함 (4절) | 해당 없음 | 해당 없음 | 해당 없음 |

## 3. Iceberg 안전 불변식

정리 작업은 최소 복구 기간을 침해하면 안 되고, 고아 파일 제거는 진행 중인 쓰기와 경합하면 안 된다.

1. **I1 (복구 기간).** `expire_snapshots` 임계값 >= 문서화된 최소 복구 기간 R. Trino는 `iceberg.expire-snapshots.min-retention`(기본 7일)으로 하한을 강제하고 그보다 짧으면 프로시저가 실패한다 [S6]. 제안: R = 7일 (Trino 하한 및 현재 DAG와 동일), 소유자가 늘릴 수 있음 (D3). 작업을 통과시키려고 Trino 하한을 낮추지 않는다.
2. **I2 (고아 파일 연령).** `remove_orphan_files` 연령은 가장 긴 쓰기/커밋 시간보다 길어야 한다. Iceberg: "쓰기가 완료될 것으로 예상되는 시간보다 짧은 보존 간격"으로 고아 파일을 제거하는 것은 위험하며 "테이블을 손상시킬 수 있다", 기본 3일 [S3]. Lakekeeper는 명시적으로 검사를 끄지 않는 한 24시간 미만을 거부한다 [S7]. 제안: 7일 (Trino/Lakekeeper 기본). 또한 `고아 연령 >= I1 연령`으로 복구 가능한 스냅샷이 참조하는 파일이 고아로 판정되지 않게 한다 (S3, S7의 "만료 후 고아 제거"에서 도출한 Beluga 설계 규칙).
3. **I3 (순서).** expire_snapshots 다음 remove_orphan_files [S7]. 현재 DAG 순서는 optimize 다음 expire이며, 고아 작업은 expire 뒤에 추가해야 한다.
4. **I4 (soft deletion 상호작용, 엔진별).** Lakekeeper 문서: soft deletion을 켜면 `push-s3-delete-disabled`(기본 true)가 클라이언트에 `s3.delete-enabled=false`를 전달하고, 이는 "`expire_snapshots` 같은 유지보수 프로시저를 포함한 모든 파일 삭제 작업에 영향"을 준다. 문서화된 재정의(`s3.delete-enabled=true`)는 Spark/Iceberg 라이브러리 클라이언트 예시로만 제시된다 [S8, S9]. 따라서 이 속성을 읽는 Iceberg FileIO 클라이언트(Spark 및 기타 Iceberg 라이브러리 S3FileIO)에 적용된다. Trino 483은 자체 파일시스템 계층(`TrinoFileSystem` 위의 `ForwardingFileIo`)으로 삭제하며 읽은 Trino Iceberg 문서에는 `s3.delete-enabled`가 없어 [S6], Trino로 실행하는 `expire_snapshots`/`remove_orphan_files`가 이 설정에 막힌다고 **문서화되어 있지 않다**. 이는 소스 판독이며 **런타임 검증은 하지 않았다**: D7 활성화 전에 soft deletion 웨어하우스에서 두 프로시저를 Trino로 실행하는 테스트(5절)를 추가한다. Spark 기반 유지보수가 있다면 문서화된 재정의가 필요하다.
5. **I5 (테이블 데이터에 버킷 lifecycle 금지).** 2.3 참고 (Beluga 설계 규칙).
6. **I6 (멱등성, 관측 가능성).** Iceberg 프로시저는 재실행 가능하며, Trino `remove_orphan_files`는 `processed_manifests_count`, `active_files_count`, `scanned_files_count`, `deleted_files_count`, `deleted_bytes`를 반환한다 [S6]. DAG는 이 지표를 기록하고, Trino의 보존 기간 부족 오류에 더 작은 값으로 재시도하지 말고 실패시켜야 한다.

## 4. 법적 보존(legal hold)과 purge 승인 (설계만)

구현된 것은 없으며 이후 구현을 위한 원칙이다.

- **삭제 전 hold 확인.** 모든 purge, 만료, 버킷 단위 삭제는 먼저 hold 레지스트리를 확인한다. hold 대상 데이터셋은 expire/orphan/drop에서 제외한다.
- **업스트림에 문서화된 hold 수단:** Iceberg 스냅샷 tag/branch는 기본적으로 영구 보존 (`history.expire.max-ref-age-ms` = `Long.MAX_VALUE`, `main`만 스냅샷 연령으로 제한) [S4]; Lakekeeper "protection"은 보호된 엔티티에 대한 표준 삭제 호출을 거부 [S8]; SeaweedFS Object Lock (legal hold / retention) [S13]. 어떤 수단을 쓸지는 D10. **Iceberg tag는 스냅샷 만료만 제어하며 `DROP TABLE`을 막지 않는다.** 따라서 tag만으로 hold를 구성해서는 안 되며, hold 설계에는 별도의 drop 차단 수단, 즉 Lakekeeper protection [S8] 또는 인가 백엔드(OpenFGA)에서 drop 권한 제거(읽은 문서에서 메커니즘 미검증)가 필요하고 purge 작업은 1단계에서 이를 확인해야 한다.
- **승인된 purge = 2인 승인, 기록, 반복 가능.** purge 요청은 데이터셋 + 사유 + 승인자를 명시하고, 멱등 작업이 다음 순서로 수행한다. Trino의 `expire_snapshots`/`remove_orphan_files`는 테이블이 존재해야 하고 drop 이후에는 그 지표를 얻을 수 없기 때문이다 [S6]: (1) drop 차단 수단 포함 hold 없음 확인; (2) 테이블이 존재하는 동안 인벤토리 기록 (스냅샷 목록, 파일/바이트 수); (3) 테이블이 존재하는 동안 `expire_snapshots` 후 `remove_orphan_files` 실행, 임계값은 복구 기간 이상(I1/I2; 이 프로시저는 Trino 최소값 아래로 내려갈 수 없고 현재 스냅샷의 파일은 제거하지 않음)이며 출력 지표를 보존 [S6]; (4) Trino에서 일반 `DROP TABLE`로 drop: Trino 483에는 `PURGE` 절이 없고(문법 `DROP TABLE [ IF EXISTS ] table_name`) [S25], REST 카탈로그 구현이 모든 drop에서 카탈로그의 purge-table 동작을 호출하므로(Trino 483 소스 `TrinoRestCatalog.dropTable` -> `purgeTable`) [S26] Lakekeeper는 `purgeRequested`를 받는다. Trino 없이 하려면 Lakekeeper/Iceberg REST `dropTable`을 `purgeRequested=true`로 호출한다 [S8]. Lakekeeper soft deletion이 켜져 있으면 만료 지연 전까지 테이블과 파일이 복구 가능하게 유지되고 그 후 제거된다 [S8]. purge 시 스스로 파일을 삭제하는 클라이언트(Spark `PURGE` 위험)는 사용하지 않는다 [S8]; (5) 부재 검증: Lakekeeper 테이블 목록, Trino `SHOW TABLES`, SeaweedFS의 테이블 위치 아래 오브젝트 없음 (soft deletion이면 지연 이후); (6) OpenMetadata hard delete [S20]. **감사 기록은 마지막이 아니라 먼저 쓰고 갱신한다:** 작업은 1단계 전에 `approved`(누가, 무엇을, 왜, 승인자), 4단계 직후 `executed`(2단계 인벤토리, 3단계 건수, drop 결과), 이후 후속 상태로 `verified`(5단계 결과, soft-delete 지연 이후) 또는 `failed`(단계, 오류)를 기록한다. 어느 단계가 실패해도 `approved`/`executed`/`failed` 기록이 남고, 작업은 마지막 기록 상태부터 재실행할 수 있다.
- purge 감사 기록은 `audit` 등급이며 같은 작업이 purge하지 않는다.

## 5. 검증 테스트 아이디어 (인수 기준)

이슈 #18 인수 기준에 대응한다. 아이디어이며 이 PR에서 구현하지 않는다. 기존 테스트 스타일: `tests/*.sh`, `scripts/ci/check-*.py`.

| 기준 | 테스트 아이디어 | 수준 |
|---|---|---|
| 모든 영속 데이터 등급에 보존 정책이 있음 | `check-data-standards.py` 스타일 정적 검사 확장: 1절의 모든 등급에 값 또는 명시적 "소유자 결정 대기"가 있고, `VERSIONS.md`의 저장소 중 정책이 없는 것이 있으면 실패 | 정적 |
| 작업이 멱등이며 관측 가능 | 시드 테이블에서 유지보수 DAG 태스크를 두 번 실행, 두 번째는 `deleted_files_count = 0`이며 오류 없음, DAG가 프로시저 지표를 로그로 남김 | 클러스터 |
| Iceberg 정리가 복구 기간을 준수 | 정적: DAG 임계값 >= 문서의 R, 고아 연령 >= R. 런타임: `expire_snapshots(retention_threshold => '1d')` 시도 시 Trino의 "shorter than the minimum retention" 오류 확인 | 정적 + 클러스터 |
| 고아 제거 안전성 | 느린 쓰기를 시작하고 고아 제거 실행, 진행 중 파일이 남는지 확인; 임계값보다 어린 파일이 유지되는지 확인 | 클러스터 |
| 테이블 데이터에 버킷 lifecycle 없음 | 정적/런타임: `beluga-lake`의 `GetBucketLifecycleConfiguration`에 `raw/`, `curated/`와 매칭되는 규칙이 없음 | 정적 + 런타임 |
| 삭제된 데이터셋이 검색되지 않음 | 테스트 테이블 drop 후 Lakekeeper 목록, Trino `SHOW TABLES`, OpenMetadata 검색에서 모두 사라졌는지 확인; soft delete 가시성 동작(업스트림 미문서화)은 별도로 확인 | 클러스터 |
| purge가 감사 가능하고 반복 가능 | purge 작업을 두 번 실행, 의도한 변경당 감사 기록 1건이고 두 번째 실행은 no-op | 클러스터 |
| Kafka 보존 선언 | `kafka-configs.sh`로 토픽 설정 조회, 각 CDC 토픽의 `retention.ms`/`cleanup.policy`가 선언값과 같음 | 클러스터 |
| 백업 보존 | 기간을 넘긴 CNPG `Backup` 객체가 사라지고 가장 오래된 유지 백업에 필요한 WAL이 남아 있음; 버저닝/Object Lock 버킷에서는 `ListObjectVersions`도 호출해 통과 조건: 설정 기간 + SeaweedFS lifecycle 1회 실행 이후(워커는 기본 매일 실행되므로 삭제가 약 하루 지연될 수 있음 [S12]), 기록된 legal hold 또는 만료되지 않은 Object Lock 보존 하의 버전(테스트 출력에 명시 나열)을 제외하고 non-current 버전/delete marker가 없으며 버킷 사용량이 증가하지 않음 | 클러스터 |

## 소유자 결정 사항

각 항목에 제안과 출처를 적었다. "NOR" = 공식 권고 없음. 숫자는 소유자가 정한다.

| ID | 결정 | 제안 | 출처 / 근거 |
|---|---|---|---|
| D1 | 토픽군별 raw Kafka 보존 (시간/크기) | `retention.ms` 7일, `retention.bytes` 무제한 유지 | Kafka 기본값 [S1]. CDC 전용 값은 NOR |
| D2 | CDC 토픽 `cleanup.policy`: `delete`, `compact`, 또는 둘 다 | `delete` 유지; 컨슈머가 키 기반 상태 재생을 필요로 할 때만 `compact` | Debezium: 컴팩션과 호환, 권고 없음 [S22]; Kafka 의미 [S1]. NOR |
| D3 | 스냅샷 보존 R 및 `retain_last` | R = 7일; `retain_last` = Iceberg/Trino 기본 1 (N개 버전을 원하면 소유자가 지정) | Trino 하한 7일 [S6]; Iceberg 기본 5일 [S4] |
| D4 | 고아 파일 연령 | 7일 | Trino, Lakekeeper 기본 [S6, S7]; Iceberg 기본 3일 [S3] |
| D5 | 유지보수 DAG 확장: `customers`/`orders` expire 추가, `remove_orphan_files` 추가, 주기 (현재 매시간) | 두 가지 모두 예; 주기는 NOR (Iceberg: "주기적으로", "자주 실행할 필요는 없을 수 있음" [S3]) | 저장소 격차 |
| D6 | `tmp/` 만료 일수 및 멀티파트 중단 일수 | NOR | SeaweedFS가 규칙을 지원 [S12] |
| D7 | Lakekeeper soft deletion 활성화 및 지연; `push-s3-delete-disabled` 상호작용을 엔진별로 확인 (I4) | I4 해법과 함께일 때만 활성화; 지연은 NOR | S8, S9 |
| D8 | Flink `num-retained`, `externalized-checkpoint-retention`, `execution.checkpointing.dir` 선언 | 이전 체크포인트에서 재시작이 요구사항이 되기 전까지 기본값(1 / `NO_EXTERNALIZED_CHECKPOINTS`) 유지; NOR | S11 |
| D9 | PostgreSQL 감사/운영 로그 보존 및 pgaudit 배포 여부 | NOR; 채택 시 시간 파티셔닝과 drop/detach [S17], 로그 로테이션은 S16 | S16, S17, S18 |
| D10 | 백업 보존 (현재 30일), deprecated `retentionPolicy`에서 이전, Object Lock 모드, hold 수단 | 플러그인 이전 전까지 30일 유지; 모드와 hold 수단은 NOR | S19, S13, S4, S8 |
| D11 | 등급별(raw/curated/audit) 업무 보존 기간 | NOR. 기존 선언 목표: P365D / P90D | `policies/data-standards.yaml` |
| D12 | purge 시 OpenMetadata hard delete vs soft delete; soft delete 자산을 숨겨야 하는지 | 승인된 purge에는 hard delete | S20, S21 (soft delete 가시성은 읽은 페이지에 문서화되지 않음) |

## 출처

모든 접근일 2026-10-07. 문서 원본을 읽기 위해 raw 파일 URL을 사용했으며, 인용 대상은 게시되었거나 태그된 문서이다.

| ID | 출처 |
|---|---|
| S1 | Apache Kafka 4.3, Topic-Level Configs: https://kafka.apache.org/43/generated/topic_config.html |
| S2 | Apache Kafka 4.2, Broker Configs: https://kafka.apache.org/42/generated/kafka_config.html (`log.retention.*`, `log.retention.check.interval.ms`, `offsets.retention.minutes`는 4.2 페이지에서 읽었고 4.3에서 재확인하지 않음) |
| S3 | Apache Iceberg, Maintenance: https://iceberg.apache.org/docs/latest/maintenance/ |
| S4 | Apache Iceberg, Configuration: https://iceberg.apache.org/docs/latest/configuration/ |
| S5 | Apache Iceberg, Spark Procedures: https://iceberg.apache.org/docs/latest/spark-procedures/ |
| S6 | Trino 483, Iceberg connector: https://trino.io/docs/483/connector/iceberg.html |
| S7 | Lakekeeper v0.13.1, Table Maintenance: https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/table-maintenance.md |
| S8 | Lakekeeper v0.13.1, Concepts (warehouse, soft deletion, protection): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/concepts.md |
| S9 | Lakekeeper v0.13.1, Storage (`push-s3-delete-disabled`): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/storage.md |
| S10 | Lakekeeper v0.13.1, Configuration (task queue; Plus 라이선스): https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/configuration.md |
| S11 | Apache Flink 1.20, Configuration: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/config/ |
| S12 | SeaweedFS wiki, S3 Lifecycle: https://github.com/seaweedfs/seaweedfs/wiki/S3-Lifecycle |
| S13 | SeaweedFS wiki, S3 API FAQ (Object Lock, versioning): https://github.com/seaweedfs/seaweedfs/wiki/S3-API-FAQ |
| S14 | SeaweedFS wiki, Amazon S3 API (lifecycle: "Transition rules not supported"): https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API |
| S15 | SeaweedFS wiki, Store file with a Time To Live: https://github.com/seaweedfs/seaweedfs/wiki/Store-file-with-a-Time-To-Live |
| S16 | PostgreSQL 17, Error Reporting and Logging: https://www.postgresql.org/docs/17/runtime-config-logging.html |
| S17 | PostgreSQL 17, Table Partitioning: https://www.postgresql.org/docs/17/ddl-partitioning.html |
| S18 | pgAudit README: https://github.com/pgaudit/pgaudit |
| S19 | CloudNativePG v1.30.0, Backup (Retention Policies): https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/backup.md |
| S20 | OpenMetadata, How to Delete a Data Asset: https://docs.open-metadata.org/latest/how-to-guides/guide-for-data-users/delete |
| S21 | OpenMetadata, Iceberg connector (Mark Deleted Tables): https://docs.open-metadata.org/latest/connectors/database/iceberg |
| S22 | Debezium, PostgreSQL connector (로그 컴팩션, tombstone): https://debezium.io/documentation/reference/stable/connectors/postgresql.html |
| S23 | Debezium, Topic auto-creation: https://debezium.io/documentation/reference/stable/configuration/topic-auto-create-config.html |
| S24 | Strimzi, KafkaTopicSpec (`config` 맵): https://strimzi.io/docs/operators/latest/configuring.html |
| S25 | Trino 483, DROP TABLE: https://trino.io/docs/483/sql/drop-table.html |
| S26 | Trino 483 소스, `TrinoRestCatalog.java` (`dropTable`/`purgeTable`): https://github.com/trinodb/trino/blob/483/plugin/trino-iceberg/src/main/java/io/trino/plugin/iceberg/catalog/rest/TrinoRestCatalog.java |

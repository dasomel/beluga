# 데이터 표준 기준선

[English](data-standards.md) | 한국어

이 Issue #33 제한 범위는 지속 저장되고 접근 정책에 노출되는 5개 테이블의 적합성과 측정 가능성을 만든다. 기계 판정의 단일 원천은 [`policies/data-standards.yaml`](../policies/data-standards.yaml)이며, 이 문서는 그 정책을 설명할 뿐 값을 복제하지 않는다.

## 범위와 대표 스키마

| 영역 | 대표 테이블 | 권위 있는 DDL |
|---|---|---|
| PostgreSQL 원천 | `public.customers`, `public.orders` | `gitops/charts/beluga-data/files/shop-schema.sql` |
| Iceberg 정본 | `lake.customers`, `lake.orders`, `lake.events_enriched` | `gitops/charts/beluga-data/files/flink-sql/*.sql` |

선정 대상은 `policies/resources.yaml`에 선언되고 플랫폼 접근 정책이 적용되는 지속 테이블이다. Flink 커넥터 내부 테이블(`cdc_*_source`, `kafka_clickstream`)과 여기서 파생되는 Kafka 토픽은 전송 스키마이므로 이 범위의 지속 관리 데이터셋이 아니다. 후속 확장은 wire 형식을 정본 메타데이터로 간주하지 말고 명시적으로 추가해야 한다.

## 명명과 도메인

스키마·테이블·컬럼 식별자는 소문자로 시작하는 lower `snake_case`이며 소문자, 숫자, 밑줄만 쓴다. 기존 대표 DDL에서 `_id`는 엔터티 식별자, `_at`는 timestamp 형식의 시각을 뜻한다. 새 `_date`는 달력 날짜를 뜻하며 `DATE` 형식이어야 한다. 현재 대표 필드에는 `_date` 사례가 없다.

새 SQL 예약 식별자는 금지한다. 지속 대표 범위에는 의도적 예외가 없다. producer payload를 그대로 미러링하는 quoted Flink 전송 필드 ``timestamp``는 범위 밖이며, 지속 데이터셋의 선례가 아니다.

## 필수 메타데이터

모든 테이블은 `owner`, `classification`, `description`, `retention`, `freshness`를 선언한다. 모든 컬럼은 `description`, `classification`을 선언한다. 값은 YAML 레지스트리에 둔다. `classification`은 정책 허용값 중 하나이고 `retention`/`freshness`는 정책의 ISO-8601 기간 정규식과 일치해야 한다. 이 기준선에서는 선택된 지속 데이터셋 모두에 두 항목이 적용된다. 목표값 선언이 실제 보존·신선도 실행을 뜻하지는 않는다.

## 적합성과 완전성

`python3 scripts/ci/check-data-standards.py`는 각 선택 DDL 파일에서 SQL 주석을 먼저 제거한 뒤, 컬럼 목록·`IF NOT EXISTS`·CTAS·`LIKE`를 포함한 모든 비임시 `CREATE TABLE` 문을 파싱한다. 임시 테이블과 임시 뷰는 지속 관리 데이터셋이 아닌 실행 중 객체이므로 명시적으로 제외한다. 범위 안에서 생성된 모든 테이블은 레지스트리와 1:1 대응해야 하므로 CTAS를 포함한 신규 미등록 지속 DDL과 오래된 레지스트리 항목은 실패한다. CTAS나 `LIKE`처럼 검증할 컬럼을 선언하지 않는 형식은 무시하지 않고 명시적인 `unsupported DDL form` 진단으로 fail-closed 한다. 이후 명명·접미사 형식·메타데이터도 검사한다. 테이블별 완전성은 존재하는 필수 테이블·등록 컬럼 필드 수를 전체 필수 필드 수로 나눈 비율이며 YAML 임계값 아래면 실패한다.

YAML의 `baselines`는 실제 기존 위반만 위한 래칫이다. 모든 항목은 이슈와 사유를 가져야 하고 현재 위반과 정확히 일치해야 하며, 신규 위반을 억제할 수 없다. 선택한 5개 스키마는 모두 적합하므로 현재 목록은 비어 있다. 검사는 `make validate`에 포함된다.

승인 이력, 원천-정본 매핑 카탈로그, 호환성 승인, OpenMetadata 연동은 이 슬라이스 범위 밖이다.

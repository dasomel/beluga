# 데이터 제품 계약 (#91)

`lake.events_enriched.json`은 기존 [제안서](../docs/data-contract-standard.md)의
첫 정적 구현이다. 사용자별 1분 집계인 Gold 유사 제품이며, 인증된 Gold를 뜻하지 않는다.
표준은 [ODCS v3.2.0](https://github.com/bitol-io/open-data-contract-standard/blob/v3.2.0/schema/odcs-json-schema-v3.2.0.json)으로
고정한다. JSON은 ODCS의 기계 판독 표현이며 YAML 의존성 없이 Python stdlib로 읽는다.
외부 검증 도구나 라이선스/SBOM 검토 대상인 새 의존성을 추가하지 않는다.

```sh
python3 scripts/ci/check-data-contracts.py
python3 scripts/ci/check-data-contracts.py --self-test
make validate
```

검증기는 ODCS 전체 JSON Schema 검증기가 아닌 **Beluga 최소 프로파일**이다.
ODCS 필수 문자열 `apiVersion`, `kind`, `id`, `version`과 Beluga 필수
`status`, `name`, `domain`, 용도/사용 제한, owner, 제품 스키마 및 컬럼 설명/분류를
검사한다. 버전은 `major.minor.patch`, 표준 버전은 `v3.2.0`이어야 한다.
`schema[].properties[]`의 이름/`physicalType`은
[실제 Flink DDL](../gitops/charts/beluga-data/files/flink-sql/events_sessionization.sql)의
`lakekeeper.lake.events_enriched`와 정확히 일치해야 한다. 순서는 무관하며
추가/삭제/이름/타입 변경과 중복은 실패한다. `logicalType`도 물리 타입과 대조한다.
파서는 현재 DDL의 STRING/BIGINT/TIMESTAMP(3) 및 NOT ENFORCED 기본 키만 지원하고,
새 구문은 명시적으로 확장하기 전까지 실패한다. PK/NULL 보장 대조는 아직 지원하지 않는다.
`--contract <JSON>`으로 다른 fixture를, `--root <checkout>`으로 다른 DDL 원천을 검사할 수 있다.
기본 계약 또는 원천 파일이 없거나 JSON이 손상되면 종료 코드 1이다.
self-test는 `tests/fixtures/data-contracts/`의 정상/누락/변조 파일과
추가 변형 및 실제 CLI 오류 경로를 검사한다. `make validate`와 기존 CI validate job에 포함된다.

컬럼/타입의 원천은 DDL이고 소유자·분류·보존·신선도 목표의 원천은
[registry](../policies/data-standards.yaml)다. 계약의 `customProperties`는 원천 및
현재 스트림→집계 lineage를 가리키는 힌트다. 신선도 `PT5M`은 기존 제안서 D8에 따라
단위 변환 없이 기록한다. 품질 규칙은 아직 text 기대값이며 SLA/분류/소유자와 registry 간
일치 검사나 실제 데이터 측정을 이 검증기가 수행하지는 않는다.

계약 변경은 버전을 올리고 Git/PR 리뷰에 근거를 남긴다. `git log -- contracts/`로
이력을 조회할 수 있으나 승인/버전 증가를 자동 강제하지는 않는다. DDL과 계약을 동시에
변경하면 이 검사는 통과할 수 있다. 이전 릴리스 대비 호환성 판정, 발행 차단,
품질/SLA 실행, 카탈로그 동기화, API/AsyncAPI 참조, 유효/만료일 및 승인 감사 강제는
#91 후속 범위다. 런타임·권한·정책·이미지 버전은 변경하지 않는다.

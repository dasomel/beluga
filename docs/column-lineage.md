# 정적 컬럼 lineage (#88)

저장소의 실제 SQL을 분석하는 오프라인 도구다. stdlib Python만 사용하며 SQL을
실행하거나 클러스터·카탈로그에 접근하지 않는다. 기존
[lineage 제안](lineage-and-metadata-quality.md)의 L4에 대한 제한된 첫 구현이다.
현재 별도의 lineage 레지스트리는 없으며 `policies/data-standards.yaml`은
거버넌스 메타데이터 원천으로 그대로 유지한다. 해당 레지스트리나 소비자의
계약을 변경하지 않는다.

```sh
python3 scripts/ci/check-column-lineage.py > /tmp/column-lineage.json
python3 scripts/ci/check-column-lineage.py --output docs/generated/column-lineage.json
python3 scripts/ci/check-column-lineage.py --check
python3 tests/test_column_lineage.py
```

`make validate`는 테스트와 커밋된 보고서의 재생성 일치 검사를 실행한다.
`--check`는 입력 누락, SQL 변경, 보고서 누락/변조 시 종료코드 1을 반환한다.
미지원 SQL은 정상적인 분석 결과인 `unknown`으로 기록하므로 그 자체로 검사를
실패시키지 않는다. 파싱 불가능한 입력이나 파일 오류는 실패한다.
`--root`로 fixture 저장소를 지정할 수 있고 `--output`은 보고서 경로를 지정한다.

## 범위와 해석

- 입력: `gitops/**/*.sql`, `sql/**/*.sql` 전체(경로 정렬). YAML/Python/shell에
  내장된 SQL과 Helm 렌더 결과는 읽지 않는다. 현재 Trino 뷰 파일은 없다.
- 지원: Flink `INSERT INTO … SELECT`, 선택적인 대상 컬럼 목록,
  Trino `CREATE [OR REPLACE] VIEW … AS SELECT`, 명시적/간단한 암시적 별칭,
  단순 산술/CASE 표현식, 평면 JOIN의 한정된 컬럼 참조, CAST/REPLACE,
  SUM/COUNT/MIN/MAX/AVG, COALESCE/NULLIF, UPPER/LOWER/TRIM/ABS/ROUND,
  TUMBLE_START/END. GROUP BY 집계의 출력 값 참조도 추출한다.
- 소스 스키마는 같은 파일의 일반 `CREATE TABLE` DDL에서만 확인한다.
  커넥터 테이블을 물리적 Kafka/PostgreSQL 엔터티로 추측해 변환하지 않는다.
  대상 INSERT의 위치 매핑은 DDL 순서 또는 명시적 컬럼 순서에 따른다.
- CTE, 하위 쿼리, UNION 등 집합 연산, OVER 윈도 함수, 테이블 함수,
  NATURAL/USING JOIN, `*`, 알 수 없는 함수/컬럼, 모호한 비한정 JOIN 컬럼,
  누락된 스키마/대상 이름, 컬럼 개수 불일치는 사유를 붙여 `unknown`으로 남긴다.
  부분적으로만 해석된 출력 컬럼의 sources는 비워 완전한 매핑으로 오인하지 않게 한다.
- 이 도구는 지원 SQL 부분집합의 **출력 값 의존성** 분석이다. WHERE/JOIN ON/
  GROUP BY/HAVING의 행 선택 의존성, SQL 유효성·타입 검증, 마스킹의 안전성은
  보장하지 않는다. 범용 SQL 파서가 아니므로 지원 범위 확대 시 fixture가 필요하다.

## JSON 계약과 현재 증거

[생성 보고서](generated/column-lineage.json)는 `version: 1`,
`extractor_version: 1`, `source: static`, confidence와 입력 파일의 SHA-256을
포함한다. Git 이력과 해시가 분석 입력 버전을 식별하며 실행 시간은 넣지 않아
재생성이 결정적이다. 추출 의미가 바뀌면 `extractor_version`을 올린다.

각 transformation은 `path`, 파일 내 1부터 시작하는 `statement`, `target`,
`status`, `reasons`, `columns`를 갖는다. 각 column은 `target_column`, 정규화한
`expression`, `sources: [{dataset, column}]`, `status`, `reasons`를 갖는다.
상수 출력은 resolved이면서 sources가 빈 배열일 수 있다. 변환 전체가 unknown이면
변환 수준의 reasons를, 특정 출력이 unknown이면 해당 컬럼의 reasons를 확인한다.
관계는 sources 각 항목에서 transformation.target/column.target_column으로 향한다.

현재 CDC customers/orders 및 events sessionization의 15개 출력 컬럼이 resolved다.
shop-schema의 시드용 중첩 VALUES INSERT…SELECT는 unknown이다. 단순 VALUES
INSERT와 DDL은 변환으로 세지 않지만 모든 입력 파일의 해시는 보관한다.
정상·별칭·CAST·JOIN·집계·따옴표/주석 fixture와 미지원·누락·변조 fixture가 있다.

남은 #88 범위: source-to-Gold 전체 경로, 런타임/OpenLineage, OpenMetadata 표시,
민감도 전파, 수동 override 감사, 스키마 변경 영향 보고서, BI/API/지표/데이터 제품
의존성 및 제공 API. 현재 JSON 내보내기는 이 기능들의 완료를 의미하지 않는다.

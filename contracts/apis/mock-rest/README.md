# Mock REST 응답 계약 드리프트 (#78)

이 디렉터리는 [소스 온보딩 제안서](../../../docs/source-onboarding-and-intake-ko.md)의
4.4절 중 오프라인 OpenAPI 문서 비교만 구현한 fixture다. HTTP 서버나 실제 커넥터는 없다.
`openapi.json`이 선언된 계약이고, `observed-*.json`은 제공자가 변경했다고 가정한
샘플 OpenAPI 문서다. 실제 HTTP 응답에서 스키마를 추론한 결과는 아니다.
stdlib만 사용하므로 제안서의 YAML 대신 JSON 표현을 사용한다.

```sh
python3 scripts/ci/check-api-contract-drift.py
python3 scripts/ci/check-api-contract-drift.py --declared contracts/apis/mock-rest/openapi.json --observed contracts/apis/mock-rest/observed-breaking.json
python3 tests/test_api_contract_drift.py
```

첫 명령은 선택 필드 `description` 추가를 `NON_BREAKING`으로 보고 종료 0,
두 번째는 `name` 삭제와 `id`의 integer → string 변경을 `BREAKING`으로 보고 종료 1이다.
입력 파일 누락·JSON 손상·미지원 스키마는 종료 2다. 보고서는 operation, 응답 상태,
미디어 타입, 중첩 필드 위치를 포함하며 정렬 순서가 고정된다.
`make validate`에서 기본 fixture 비교와 자체 테스트를 실행한다.

## 지원 범위와 판정 정책

- OpenAPI 3.0.x/3.1.x JSON의 경로별 HTTP operation과 응답 스키마를 비교한다.
  `info.title`, `info.version`, 고유 `operationId`, 비어 있지 않은 응답 정의가 필요하다.
- 명시적 `type`, 중첩 `properties`, `required`, 배열 `items`, 로컬
  `#/components/schemas/...` 참조를 지원한다. 3.0의 `nullable`과 3.1의 타입 배열을
  정규화한다. JSON 중복 키·누락 참조·순환 참조를 거부한다.
- 필드 삭제(선택 필드 포함), 타입 변경, 응답 필수 보장 해제, operation 삭제/ID 변경,
  응답 상태 추가/삭제, 미디어 타입 삭제는 파괴적 변경이다. 필드/operation/미디어 타입
  추가와 응답 필수 보장 추가는 비파괴적 변경이다. 이름 변경은 삭제+추가로 탐지한다.
  요청 스키마와는 호환성 방향이 다르므로 이 정책을 요청 검증에 사용하면 안 된다.
- description/title/example/examples/default/deprecated는 비교에서 제외한다.
  `format`, `enum`, `additionalProperties`, 조합 스키마 등 그 밖의 응답 스키마 키워드는
  안전한 판정을 위해 입력 오류로 거부한다. 외부 참조, Path Item/Response 참조도 거부한다.
  이는 전체 OpenAPI 적합성 검증기가 아닌 명시한 응답 스키마 프로파일 검증기다.
  참조되지 않은 components, 요청, 파라미터, 인증, 헤더, 서버 설정은 검증/비교하지 않는다.
- `info.version`은 제공자 계약 버전이며 fixture의 `x-beluga-source`에 소스 revision,
  이슈, 사용 제한을 기록했다. 라이선스는 `info.license`에 있다. 이 메타데이터는
  fixture 설명용이며 검사기가 승인하거나 수집 메타데이터로 전파하지 않는다.

## 남은 범위와 변경 증거

이 fixture는 합성 데이터이며 외부 서비스 호출·인증·페이지네이션·클러스터 설정을
변경하지 않는다. 실제 payload 드리프트 검사, mock HTTP 서비스, 커넥터 생성,
Silver 타입 매핑, 비 OpenAPI 계약, 계약 버전 강제/승인, 라이선스 제한 집행,
Bronze 격리와 메타데이터 보존은 #77/#78 후속 과제다.

#29/#60 연결은 현재 이슈 참조, Git diff/커밋, `make validate` CI 로그와
`tests/test_api_contract_drift.py`의 재현 가능한 good/bad fixture 검사로 한정한다.
계약 변경자는 선언/관측 fixture와 기대 분류 테스트를 함께 검토에 제출해야 한다.
자동 기준 버전 선택이나 실제 소스 온보딩/릴리스 승인 워크플로는 구현하지 않았다.

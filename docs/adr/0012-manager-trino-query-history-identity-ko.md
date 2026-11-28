# ADR-0012: Manager Trino 쿼리 이력 신원

[English](0012-manager-trino-query-history-identity.md) | 한국어

- 상태: Accepted
- 날짜: 2026-11-28
- 소유자: dasomel (오너 결정 2026-11-28: "자기 쿼리만")

## 배경

Manager 쿼리 워크스페이스는 "쿼리 이력 어댑터 미연결(503)"을 표시했다. 차트가 Trino
어댑터(`BELUGA_TRINO_*`)를 한 번도 연결하지 않았기 때문이다. 어댑터는 서비스 자격 하나로
Trino `GET /v1/query`를 호출하고, 그 결과를 인증된 모든 Manager 사용자에게 똑같이 보여 준다
(`BELUGA_TRINO_HISTORY_ACK=shared-service-credential`). 이 변경 전에는 고정 `TOKEN`/`TOKEN_FILE`만
받았으므로 Keycloak 액세스 토큰이 만료되면 끊겼다.

2026-11-28 라이브 실측(Trino 483 + 생성된 OPA 정책): `GET /v1/query`는 호출자 자신의 쿼리만
돌려줬다. `beluga-admin`은 자기 `SELECT 1`만, `svc-maintenance`는 자기 쿼리만 보였고, LDAP 항목이
없는 주체(`service-account-flink`)도 `200 []`을 받았다. 생성된 `trino.rego`에는
`ViewQueryOwnedBy`/`FilterViewQueryOwnedBy` 규칙이 없으므로, OPA를 바꾸지 않아도 다른 사용자의
쿼리는 걸러진다.

## 결정

### D-MQH-1: 전용 서비스 신원, 자기 쿼리만

`manager-query-history`는 [ADR-0010](0010-manager-lakekeeper-read-identity-ko.md) D-MCAT-1과
같은 형태의 confidential Keycloak service-account 전용 클라이언트다. 브라우저·implicit·password
플로, full scope, 기본·선택 스코프, redirect, web origin을 모두 끈다. 전용 매퍼가
`preferred_username=svc-manager-query-history`와 audience `trino`를 내보낸다. LDAP 사용자, 그룹,
OPA 권한을 두지 않으므로 자기 쿼리만 보이며, 실제로는 빈 목록이다. 다른 사용자의 SQL은 보이지
않는다(오너 결정).

bootstrap의 `ensure_cred client-secret-manager-query-history`가 `platform-system/beluga-credentials`를
채우고, `iam`과 `platform-system`에만 `keycloak-manager-query-history-secret/manager-query-history`로
복사한다. 차트 토글이 꺼져 있어도 만든다. 공유 `keycloak-client-secrets`에는 넣지 않는다. 재조정
Job은 이 자격을 비공개 자격으로 다룬다(비밀값을 로그에 남기지 않는다).
회전: 승인된 bootstrap 재실행 → Keycloak 동기화 → manager-domain-api 재시작.
비용: 클라이언트 1개와 전용 복사본 2개. 탈출구: 함께 폐기.

### D-MQH-2: 검증된 TLS와 프로세스 내 토큰 갱신

domain-api에 `BELUGA_TRINO_TOKEN_ENDPOINT` + `_CLIENT_ID` + `_CLIENT_SECRET`을 추가한다. D-MCAT-4와
같은 client_credentials 공급자를 쓴다(교환 시간 제한, 만료 전 캐시, 실패 시 닫힘). 이 값들은
`TOKEN`/`TOKEN_FILE`과 상호 배타적이다. Trino는 `https://trino.analytics.svc.cluster.local:8443`로
호출하며, `NODE_EXTRA_CA_CERTS`가 이미 마운트하는 내부 CA로 검증한다. 최종 사용자 토큰은 Trino에
전달되지 않는다. 리터럴 마스킹(`BELUGA_TRINO_HISTORY_SQL=literals`)은 기본값을 유지한다.
비용: 이력 패널이 Keycloak에 의존한다. 탈출구: 회전되는 `TOKEN_FILE`.

### D-MQH-3: 토글과 롤아웃 순서

`managerQueryHistory.enabled`(beluga-platform)가 realm 클라이언트, 재조정 Job의 Secret 참조,
Manager 환경 변수를 함께 제어한다. 기본값은 false다. 지금 고정된 Manager 이미지가
`BELUGA_TRINO_TOKEN_ENDPOINT`보다 오래되어 고정 토큰 없이는 기동에 실패하기 때문이다. 이 ADR
커밋으로 빌드한 이미지로 Manager 이미지 핀을 올리는 같은 변경에서 켠다(완료: #453 머지 커밋 d4ea6bf 빌드로 핀을 올리며 true로 켰다). NetworkPolicy 변경은
필요 없다. `analytics`에는 코디네이터를 고르는 인그레스 정책이 없고, `platform-system`에서 라이브로
접근을 확인했다. `analytics`에 default-deny를 도입할 때 다시 검토한다.
비용: 2단계 롤아웃. 탈출구: false로 되돌리면 패널이 다시 503이 된다. 권한 없는 Keycloak
클라이언트는 승인된 폐기에서 삭제할 때까지 기존 realm에 남는다.

## 검증

- 정적: `python3 tests/test_manager_query_history_render.py`(default/full/Kakao, 토글 양쪽),
  manager 단위 테스트 `packages/domain-api/tests/manager-query-history.test.ts`.
- 라이브(이미지 핀 갱신 후): `https://manager.<baseDomain>`를 거친 `GET /api/v1/query-history`가
  200을 돌려주고, domain-api 진단에 "Trino query history adapter enabled (read-only)"가 남는다.

## 알려진 문제(별도)

라이브 실측 중 Trino가 audience가 `trino`가 아닌 `lakekeeper`인 액세스 토큰도 받아들였다. 이
ADR 범위 밖이므로 별도로 추적한다. 이 신원은 audience `trino`를 명시적으로 내보낸다.

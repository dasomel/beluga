# ADR-0010: Manager Lakekeeper 읽기 전용 신원

[English](0010-manager-lakekeeper-read-identity.md) | 한국어

- Status: Accepted
- Date: 2026-11-12
- Owner: dasomel, 이슈 #372 (2026-11-12 소유자 결정)

## 배경

Overview 데이터 자산만 fixture였다. Manager SSO에서 이미 참조하는 ADR-0009를
피하고 0010을 사용한다. [ADR-0008](0008-iceberg-maintenance-service-identity-ko.md)의
전용 자격증명 패턴을 따르되 LDAP/Trino 권한은 추가하지 않는다.

## 결정

- **D-MCAT-1**: `manager-catalog-reader`는 confidential 서비스 계정 전용 클라이언트다.
  브라우저/implicit/password 흐름, 전체 scope, 공용 scope, redirect/origin을 끈다.
  전용 매퍼는 `preferred_username=svc-manager-catalog-reader`, `aud=lakekeeper`를 발급한다.
  Lakekeeper의 `preferred_username,sub` 설정으로 OpenFGA 사용자는
  `oidc~svc-manager-catalog-reader`가 된다. LDAP는 필요 없다. realm import와 Sync
  reconcile은 같은 선언을 유지하며 매퍼 부분집합 비교·재조회로 교정 결과를 확인한다.
  `ensure_cred client-secret-manager-catalog-reader`가 신규/기존 원장에 키를 추가한다.
  `keycloak-manager-catalog-reader-secret/manager-catalog-reader`는 iam/platform-system에만
  복사하고 공유 Secret에 넣지 않는다. 원장 beluga-credentials는 기존 platform-system 소유다.
  비밀값을 로그에 출력하지 않는다. 회전 순서는 승인된 bootstrap → Keycloak sync → Manager
  재시작이다. 비용: 클라이언트 하나·전용 복사본 둘. 탈출구: 함께 폐기.
- **D-MCAT-2**: 기존 lakekeeper-bootstrap Job이 현재 할당을 조회하고 warehouse `lake`의
  누락된 `describe`만 추가한다. Trino/Flink 할당은 유지한다. [v0.13.1 문서](https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/authorization-openfga.md)의
  describe는 하위 객체 목록/메타데이터 권한이며 select와 분리된다. Manager names-only 모드는
  config, 중첩 namespace 목록, table 목록 GET만 사용한다. metadata load·스토리지 위임·signer·
  데이터 조회·생성/수정/관리 권한은 없다. 비용: lake 전체 이름 공개. 탈출구: 양 차트에서 비활성화.
  비활성화만으로 기존 튜플이 삭제되지는 않으므로 폐기는 별도 승인된 revoke가 필요하다.
  외부/상속 권한은 라이브 부정 테스트로 확인하며 예기치 않은 권한은 조사한다.
- **D-MCAT-3**: 양 차트 `managerCatalogReader.enabled=true`는 default/full/Kakao 모두 필요한
  구성요소가 있기 때문이다. 구성요소 누락/allowall 프로필은 양 릴리스에서 false로 둔다.
  Secret을 먼저 준비한다. 서비스 FQDN을 쓰고 lakehouse ingress는 platform-system과
  app=manager-domain-api를 동시에 고른 TCP 8181만 허용한다. Manager egress 차단은 현재 없다.
  default-deny 도입 전에 Keycloak:8080/Lakekeeper:8181을 허용한다. baseDomain 규칙을 유지한다.
  비용: 클러스터 내부 HTTP 신뢰. 탈출구: 별도 검토한 내부 TLS.
- **D-MCAT-4**: domain-api가 scope=openid client_credentials를 교환하고 만료 전 캐시 갱신과
  단일 동시 교환을 수행한다. 1500ms 제한, redirect/대용량/잘못된 응답 거부, 비밀 오류 비출력.
  실패하면 만료 토큰이나 fixture로 대체하지 않는다. 비용: Keycloak 의존.
  탈출구: 외부 회전 TOKEN_FILE, 관리자 자격 사용 금지.
- **D-MCAT-5 / D-MCAT-6**: 인증된 모든 Manager 사용자에게 같은 이름/수를 제공하며 그룹 게이트는
  없다(소유자 결정 2). ID/kind/namespace/path/unknown 상태는 기존 계약을 지원한다.
  columns/location/properties/snapshot/credential은 반환하지 않는다. parentId 없는 kind=table/schema는
  계층을 순회해 전체 수를 계산한다. 제한 초과/잘림은 실패시켜 잘못된 수를 숨기지 않는다.
  health live는 연결 구성을 뜻하며 전체 fixtures live에 catalog도 필요하다. 장애는 503 → 기존 UI의
  unavailable 표시로 전달한다. UI는 domain-api만 호출한다. 비용: 제한된 순회·5초 캐시.
  탈출구: upstream 집계 API.

- **D-MCAT-7**: 이번 변경에서 platform 차트는 `managerCatalogReader.enabled: false`로 둔다. 이전에
  핀된 Manager 이미지는 client credentials 환경변수를 기동 시 설정 오류로 거부하므로, 옛 핀으로 켜면
  domain-api가 반복 재시작한다. 신원·권한·NetworkPolicy는 지금 배포해도 무해하고, 이미지 핀 교체 PR이
  플래그를 true로 바꾼다. 비용: PR 한 번 추가. 탈출구: false 유지(데이터 자산은 stub).

## 검증·롤아웃

오프라인 렌더/Manager 테스트/인벤토리 검증은 라이브 동작 증거가 아니다. 고정 Manager 이미지는
이번 변경에서 유지하므로 오케스트레이터가 코드를 빌드·게시하고 VERSIONS/매니페스트를 함께 갱신해야 한다.
승인된 bootstrap·GitOps 반영 뒤 두 Job과 Secret 회전을 확인하고 Manager를 재시작한다.
`MANAGER_LAKEKEEPER_LIVE=1 bash tests/30-manager-lakekeeper-assets.sh`는 analyst PKCE 세션으로
manager.<baseDomain> 진입점의 health/namespace·table 집계와 catalog 직접 목록을 비교한다.
실제 Manager 파드에서 내부 catalog 경로도 확인하고 reader의 namespace 생성이 403인지 검사한다.
만약 생성에 성공하면 고유 namespace를 보고하고 실패하며 삭제는 별도 승인된 정리로 남긴다.

라이브 미확인: 신규/기존 realm 교정, secret 회전, 실제 권한 상속/쓰기 거부, 중첩·페이지 집계 일치,
내부 네트워크, gateway TLS/PKCE, 토큰 만료 후 갱신, UI 렌더/장애 표시.
롤백: 양 차트 비활성화/원천 되돌림. 권한·자격 폐기는 별도 승인 작업이다. 정책/생성 OPA는 건드리지 않는다.

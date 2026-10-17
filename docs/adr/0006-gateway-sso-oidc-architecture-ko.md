# ADR-0006: Keycloak 및 APISIX 게이트웨이 기반 통합 SSO/OIDC 아키텍처

- Status: Accepted
- Date: 2026-10-16
- Supersedes: —
- Superseded by: —

결정 ID: D-SSO-1(선언형 단일 원천), D-SSO-2(게이트웨이 OIDC 및 헤더 위생화), D-SSO-3(공유 게이트웨이 클라이언트 및 멱등 생성), D-SSO-4(ArgoCD 네이티브 OIDC 및 그룹 매핑).
관련 브랜치: `feat/gateway-sso`.

## 배경

Beluga 데이터 플랫폼은 다수의 웹 UI 및 API 서비스를 단일 도메인 레지스트리(`*.local.beluga.internal`, 통합 HTTPS 443)를 통해 외부에 노출한다. 그러나 플랫폼 내 서비스들의 인증 역량은 파편화되어 있었다:

1. **자체 인증 기능 부재**: Apache Flink 대시보드, SeaweedFS Filer UI, Lakekeeper Web UI는 자체 인증/인가 메커니즘이 없어 내부 네트워크 또는 익명 접근에 무방비로 노출될 위험이 있었다.
2. **REST API 및 헬스 프로브 게이트웨이 OIDC 바이패스 필요**: Lakekeeper(`catalog.local.beluga.internal`)는 사람이 접근하는 Web UI(`/*`)와 머신/엔진(Trino, Flink)이 접근하는 Iceberg REST API(`/v1/*`, `/catalog/*`, `/management/*`, `/health`)가 동일한 호스트명을 공유한다. Web UI는 게이트웨이 SSO를 강제하되, Lakekeeper REST 엔드포인트(`/catalog`, `/management`, `/v1`)는 게이트웨이 OIDC를 우회하고 Lakekeeper가 Keycloak bearer 토큰을 자체 검증한다(`gitops/charts/beluga-data/templates/04-lakekeeper.yaml` `LAKEKEEPER__OPENID_*`).
3. **ArgoCD 인증 일원화**: GitOps 컨트롤 플레인인 ArgoCD는 초기 admin 로컬 비밀번호에 의존하고 있었으며, Keycloak LDAP SSO와 통합되지 않아 사용자별 권한 분리가 불가능했다.
4. **선언형 SSO 설정 부재**: 각 서비스의 OIDC 설정(클라이언트 ID, 리다이렉트 URI, 세션 쿠키, 보호/예외 경로)이 차트별로 흩어져 있거나 하드코딩되어 일관된 변경 및 검증이 어려웠다.

## 결정

### 1. D-SSO-1: 단일 선언형 SSO 원천 (`gitops/values/sso.yaml`)
모든 서비스의 SSO 메타데이터를 `gitops/values/sso.yaml`에 집중 관리한다.
- 각 엔드포인트는 `mode`(`gateway-oidc`, `app-oidc`, `none`)를 선언한다.
- `gateway-oidc`: 자체 인증이 없는 서비스에 대해 APISIX 인그레스 게이트웨이 레벨에서 `openid-connect` 플러그인을 강제한다.
- `app-oidc`: 애플리케이션 자체에서 OIDC를 네이티브 처리한다 (Keycloak 클라이언트 연동).
- `none`: 게이트웨이 및 애플리케이션 수준의 OIDC 인증을 적용하지 않는다.
- 비용 및 탈출구: Helm 렌더링 시 `-f gitops/values/sso.yaml`이 반드시 포함되어야 하며, 특정 엔드포인트의 인증을 즉시 해제해야 할 경우 `mode: none`으로 설정하면 게이트웨이 플러그인 렌더링이 바이패스된다.
- 개정 2026-10-17 (D-DOM-2): `sso.yaml`은 더 이상 도메인을 선언하지 않는다. `host`/`issuerHost`는 DNS 라벨(`flink`, `sso`)이고 FQDN은 `<label>.<baseDomain>`(차트 값 `baseDomain`; Kakao Cloud는 `gitops/values/domain-kakao.yaml`의 `kakao.beluga.internal`, Vagrant는 `local.beluga.internal` 유지), issuer는 `https://sso.<baseDomain>/realms/<realm>`으로 파생한다(`issuer` 필드 삭제). 차트(`beluga.ssoHost`)와 Domain API는 점이 든 host를 거부한다. 비용: 이 파일이 `main`에 닿기 전에 Domain API 이미지가 라벨 형식을 이해해야 하며, 그 전에는 `/api/v1/sso`가 503이다. 탈출구: 없음(FQDN 박힘 자체가 제거 대상 결함).

### 2. D-SSO-2: APISIX 게이트웨이 OIDC 및 헤더 위생화
자체 인증이 없는 서비스(Flink, SeaweedFS Filer, Lakekeeper Web UI)에 대해 APISIX `openid-connect` 플러그인을 적용한다.
- **OIDC 디스커버리 TLS 검증**: APISIX에 내부 루트 CA(`beluga-internal-ca`)를 마운트하고 `ssl_trusted_certificate` 및 `ssl_verify: true`를 지정하여 내부 Keycloak 발급 인증서를 엄격히 검증한다.
- **민감 헤더 위생화 (Header Sanitization)**: APISIX `proxy-rewrite` 플러그인을 사용하여 업스트림 백엔드로 요청을 전달하기 전 `X-Userinfo`, `X-Access-Token`, `X-ID-Token` 헤더를 제거(headers.remove)함으로써 스푸핑 및 내부 토큰 누출을 방지한다.
- **그룹 허용 목록(`allowedGroups`)**: `gitops/values/sso.yaml`의 선택적 엔드포인트별 목록으로, 사용자의 Keycloak `groups` 클레임이 맞지 않으면 게이트웨이가 403으로 응답한다(access 단계 Lua, fail-closed; ADR-0009 D-MSSO-14 참조). 현재 `flink`와 `filer`는 `[admins, engineers]`이며 `catalog-ui`는 그룹 검사가 없다.
- **Lakekeeper 라우트 분리**: Web UI(`/*`, priority: 1)와 REST API/헬스 프로브(priority: 10)를 별도 라우트로 분리하여 콜백(`/.apisix/redirect`, `/logout`) 404를 방지하고 REST 클라이언트가 게이트웨이 OIDC 간섭 없이 Keycloak bearer 토큰으로 직접 인증하도록 보장한다.

### 3. D-SSO-3: 공유 `apisix-gateway` Keycloak 클라이언트 및 멱등 생성
게이트웨이 OIDC로 보호되는 모든 엔드포인트는 Keycloak의 단일 클라이언트 `apisix-gateway`를 공유한다.
- 기 부트스트랩된 기존 클러스터에서 realm이 이미 존재할 경우 초기 임포트 JSON이 재적용되지 않는 문제를 해결하기 위해, `keycloak-clients` 부트스트랩 잡에서 Keycloak REST API(`POST /admin/realms/{realm}/clients`)를 호출하여 `apisix-gateway` 및 `argocd` 클라이언트를 멱등하게 생성/동기화한다.
- `TARGET_CLIENTS_FOR_SCOPES`에 두 클라이언트를 포함하여 LDAP `groups`, `email`, `profile` 스코프 매핑이 누락 없이 바인딩되도록 보장한다.

### 4. D-SSO-4: ArgoCD 네이티브 OIDC 및 관리자 LDAP 그룹 매핑
ArgoCD는 자체 내장 OIDC(`app-oidc`) 기능을 사용한다.
- Keycloak의 `admins` LDAP 그룹 구성원을 ArgoCD 내 `role:admin`에 매핑(`g, admins, role:admin`).
- `argocd-cm` 및 `argocd-secret`에 OIDC 발급자 URL, 클라이언트 ID/시크릿, 내부 CA 인증서(`rootCA`)를 주입하여 브라우저 리다이렉트 및 백엔드 토큰 교환이 안전하게 수행되도록 구성한다.

## 롤아웃 순서 및 선행조건 (Rollout Order)

GitOps 애플리케이션(`beluga-platform`, `beluga-data`)은 `selfHeal: true`로 동작하므로 매니페스트 적용 순서가 엄격하다:
1. **SSO 시크릿 사전 생성**: GitOps 롤아웃 전 `scripts/gitops/01-argocd-bootstrap.sh --argocd-oidc-only`를 반드시 선행 실행해야 한다.
   - 이 스크립트는 APISIX OIDC 클라이언트 시크릿(`apisix-oidc-credential`, `keycloak-apisix-client-secret`), ArgoCD 클라이언트 시크릿(`keycloak-argocd-client-secret`), ArgoCD OIDC 설정 패치를 일괄 생성한다.
   - 내부 루트 CA(`beluga-internal-ca`) 발급을 대기(`kubectl wait --timeout=180s`)하며, 준비되지 않으면 fail-closed(exit 1)로 중단된다.
   - 모든 시크릿 패치는 argv에 평문이 노출되지 않도록 stdin(`/dev/stdin`)으로 전달된다.
2. **GitOps 동기화**: `sso.yaml`이 포함된 `beluga-platform` 및 `beluga-data`가 동기화되어 APISIX 라우트 및 Keycloak 클라이언트가 배포된다.
   - 롤아웃 순서 주의: Keycloak `argocd` 클라이언트가 생성되기 전에 ArgoCD OIDC 설정이 먼저 적용되면, GitOps 동기화가 클라이언트를 생성하기 전까지 로그인이 실패한다.
3. **검증**: `tests/20-gateway-sso.sh` 및 `scripts/ci/check-gateway-sso.py`를 통해 OIDC 리다이렉트 및 평문 시크릿 부재를 검증한다.

## 결과

- Flink 대시보드, SeaweedFS Filer, Lakekeeper Web UI가 단일 로그인(SSO)으로 보호된다.
- Lakekeeper Web UI(`catalog-ui`)의 경우 게이트웨이 OIDC가 외곽에서 UI 정적 에셋 및 HTML을 보호하고, 브라우저 SPA는 공개 Keycloak 클라이언트(`lakekeeper`)를 통해 PKCE로 Management API용 bearer 토큰을 발급받는다. 이미 게이트웨이 단계에서 활성화된 Keycloak SSO 세션이 존재하므로 이중 로그인 프롬프트 없이 매끄럽게 연결된다.
- Lakekeeper REST API 및 헬스 체크는 게이트웨이 OIDC를 우회하고 자체 Keycloak bearer 토큰 인증으로 동작한다.
- ArgoCD가 Keycloak LDAP SSO와 통합되어 개별 계정 로그인 및 그룹 기반 관리자 권한 관리가 가능해진다.
- `check-gateway-sso.py` CI 게이트를 통해 OIDC 엔드포인트 계약, FQDN 일치, 평문 시크릿 배제, CSP 오버레이 일관성이 자동으로 보장된다.

## 검토한 대안

- **각 UI 컴포넌트별 개별 OIDC 프록시(OAuth2-Proxy) 사이드카 배포**: 파드마다 리소스가 낭비되고 관리가 복잡해지므로 중앙 APISIX 인그레스 플러그인(D-SSO-2)을 채택.
- **서비스별 개별 Keycloak 클라이언트 생성**: 관리 포인트가 증가하고 시크릿 동기화 부담이 커지므로 게이트웨이 보호 서비스는 단일 `apisix-gateway` 클라이언트를 공유(D-SSO-3)하도록 단순화.

## 알려진 한계 및 후속 과제 (Known Gaps / Follow-ups)

- **OpenMetadata GitOps 동기화 누락**:
  - *문제*: OpenMetadata 매니페스트는 ArgoCD Application의 지속적인 동기화 관리 대상에 포함되지 않아, Git 저장소 변경 사항(OIDC confidential 모드 설정 및 내부 CA 트러스트스토어 주입 등)이 라이브 클러스터에 자동 롤아웃되지 않는다 (카카오 클라우드 실측: OM 파드가 10시간 전 기동된 상태로 유지되며 이전 public/id_token 설정을 그대로 보유).
  - *근거*: `scripts/gitops/01-argocd-bootstrap.sh`(초기 부트스트랩 스크립트)에서 초기 부트스트랩 시 `helm template --set openmetadata.enabled="${ENABLE_OPENMETADATA:-false}" | kubectl apply`로 1회성 적용만 수행된다. 루트 GitOps Application(`gitops/apps/beluga-data.yaml`)의 `spec.source.helm.parameters`에는 `openmetadata.enabled`가 전달되지 않아 ArgoCD가 OpenMetadata 리소스를 관리하지 않는다.
  - *해결 방향*: 환경 프로파일 또는 클라우드 오버레이 Application 매니페스트(`gitops/apps/beluga-data.yaml` / CSP 오버레이)에서 `openmetadata.enabled`를 Application helm parameter로 주입하도록 개선하여, ArgoCD가 OpenMetadata의 라이프사이클과 자동 롤아웃을 전담하도록 전환한다.

# ADR-0005: Beluga와의 배포 및 GitOps 통합

- **상태**: 제안됨 — 설계 방향만 다룬다. 이 ADR은 chart, Application, API를 구현하지 않는다.
  Phase 1(컨테이너 이미지, 커밋 `37e8507`)은 이미 배포되었다.
- **날짜**: 2026-10-01
- **이슈**: [#25 \[ROADMAP\]\[ARCH\] Deployment & GitOps Integration with Beluga](https://github.com/dasomel/beluga-manager/issues/25)
- **상위 에픽**: #1
- **관련**: [ADR-0002](0002-backend-api-technology-ko.md) (백엔드 스택), `packages/domain-api`
  (코드: `PORT`를 읽고 `GET /api/v1/health`를 제공), 루트 워크스페이스 `AGENTS.md` (Seam: `*.local.beluga.internal`
  HTTPS 443 경계)
- **결정자**: dasomel

## 배경

Beluga(`beluga/`)는 클러스터 프로비저닝과 GitOps를 소유한다. ArgoCD app-of-apps
(`gitops/apps/app-of-apps.yaml`, `beluga-root`, 자동 prune + selfHeal)가
`https://github.com/dasomel/beluga.git`의 `gitops/charts/<name>`마다 `Application`을 하나씩
(`beluga-platform`, `beluga-data`) 렌더링하며 `CreateNamespace=true`, `ServerSideApply=true`를
쓴다. 컴포넌트 버전은 `beluga/VERSIONS.md`에 고정되고, ArgoCD는
`https://argocd.local.beluga.internal`로 접근한다.

Beluga Manager는 이미지 두 개(`ghcr.io/dasomel/*`)를 낸다: `domain-api`(포트 8787, 비루트 `node`
사용자, `/api/v1/health` `HEALTHCHECK`)와 `web`(nginx, 포트 80). 이슈의 원칙은 Manager가
Beluga의 deployment/IaC를 중복 소유하지 않고, Beluga의 GitOps 패턴에 맞춰 독립 컴포넌트로
배포 가능해야 하며 air-gapped/self-hosted 환경도 지원하는 것이다.

## 결정 동인

- 클러스터 상태의 단일 소유자: Beluga의 GitOps 저장소.
- Manager의 독립 릴리스 주기.
- 이 저장소에 레지스트리/클러스터 자격증명을 두지 않는다.
- Air-gapped 동작: 이미지·chart 미러링 가능, 런타임에 외부 매니페스트를 받지 않는다.

## 검토한 선택지

1. **chart는 beluga-manager, Application은 beluga** — chart가 배포 대상 코드와 함께 버전 관리되고
   Beluga의 app-of-apps는 이를 참조만 한다.
2. **chart와 Application 모두 beluga**(`gitops/charts/beluga-manager`) — 기존 두 chart와 정확히
   같은 방식이며 Manager 저장소는 이미지만 게시한다.
3. **beluga-manager의 Kustomize overlay** — Beluga 어디에서도 쓰지 않는 추가 렌더링 경로.

## 결정

**제안 선택: 선택지 1**(chart는 여기, Application은 Beluga), Beluga 패턴에 맞춰 연결. dasomel의 승인은 대기 중이며 미결 사항 1로 추적한다.

- **Chart**: 이 저장소의 `charts/beluga-manager`(Helm만 사용, Kustomize 없음. Beluga도 Helm만
  쓴다). Deployment 2개(`domain-api`, `web`), Service, ConfigMap. 이미지 태그는 고정하며 `latest`
  금지.
- **등록**: `beluga/gitops/apps/`에 세 번째 `Application`(`beluga-manager.yaml`)을 추가하고
  `syncPolicy`는 기존 둘과 같게, destination 네임스페이스는 `beluga-manager`로 한다. Beluga가
  소유하는 변경은 이것뿐이며, Manager는 Beluga 저장소를 수정하거나 ArgoCD 쓰기 API를 호출하지
  않는다.
- **네임스페이스 / 신원**: 전용 네임스페이스와 Deployment별 ServiceAccount. Kubernetes API가
  필요한 기능이 생기기 전까지(현재 없음) `automountServiceAccountToken: false`.
- **설정 / 시크릿**: 비밀이 아닌 설정은 ConfigMap, 시크릿은 기존 Kubernetes Secret 참조로만
  (예: Keycloak client). chart values에 시크릿 값을 넣지 않는다.
- **Ingress**: Beluga의 APISIX 게이트웨이를 통해 `*.local.beluga.internal` 규약으로 노출한다.
  라우트 매니페스트는 Manager chart가 아니라 Beluga의 다른 라우트와 함께 둔다.
- **Health**: readiness/liveness는 `GET /api/v1/health`(domain-api)와 `/`(web)로, 이미지
  `HEALTHCHECK`와 일치시킨다.
- **업그레이드 / 롤백**: 소유 chart의 이미지 태그를 Git revert하면 ArgoCD selfHeal이 롤백을
  수행한다. Manager가 sync를 시작하지 않는다.
- **읽기 전용 경계**: 이후 Manager가 배포/GitOps 상태를 보여준다면 어댑터 모델에 따른 읽기 전용
  도메인 리소스(Domain API -> ArgoCD 읽기 API)로만 제공하며, sync·롤백 등 쓰기는 하지 않는다.
  Sync 상태는 추론이 아니라 업스트림 사실이다.

## 결과

- 장점: 클러스터 진실의 단일 원천, Manager 릴리스가 Beluga core와 독립.
- 단점: 배포 형태가 바뀌면 두 저장소를 수정해야 하고(chart는 여기, Application은 저쪽) 버전 차이는
  `VERSIONS.md`로 추적해야 한다.
- Phase 2 작업(chart, Application, 레지스트리 push, 실제 클러스터 검증)은 여기서 하지 않았다:
  레지스트리 자격증명이 없고 클러스터 접근을 검증하지 못했다.

## 미결 사항

1. chart 위치: 선택지 1(여기) 대 선택지 2(Beluga). dasomel의 결정이 필요하다.
2. air-gapped 사이트의 이미지 미러링 절차(레지스트리 호스트 override 값).
3. Manager의 Keycloak OIDC를 이 chart에 둘지 `beluga-platform`(`keycloak-clients.yaml`)에 둘지.
4. 읽기 전용 ArgoCD 상태 어댑터가 MVP 범위인지(새 이슈이며 `AGENTS.md` 기준 설계 변경).

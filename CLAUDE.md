# Beluga — Project Source Map & Rules

Beluga는 Vagrant 독립 K8s 클러스터 위에 구축하는 풀스택 데이터 플랫폼이다.

## Source Map

- **전체 플랫폼 설계서**: [docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md](docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md)
- **버전 단일 원천 (Single Source of Truth)**: [VERSIONS.md](VERSIONS.md)
- **클러스터 환경 변수**: [configs/cluster.env](configs/cluster.env)
- **실수 기록 (Mistakes Log)**: [docs/mistakes-log.md](docs/mistakes-log.md)
- **구현 계획서**: [docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md](docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md)
- **라이선스 · 서드파티 고지**: [LICENSE](LICENSE) (Apache-2.0), [NOTICE](NOTICE) — 배포 컴포넌트별 라이선스는 VERSIONS.md의 "라이선스" 열이 원천. 실행 중 클러스터의 SBOM은 `bash scripts/generate-sbom.sh`로 생성.

## 도메인 레지스트리 (`*.local.beluga.internal` — Unified HTTPS 443, HTTP 80은 301 리다이렉트)

호스트 `/etc/hosts` 설정:
```text
127.0.0.1 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal sso.local.beluga.internal
```

- **Trino UI**: `https://trino.local.beluga.internal`
- **Airflow UI**: `https://airflow.local.beluga.internal`
- **Superset UI**: `https://superset.local.beluga.internal`
- **Lakekeeper REST**: `https://catalog.local.beluga.internal`
- **SeaweedFS S3**: `https://s3.local.beluga.internal`
- **ArgoCD UI**: `https://argocd.local.beluga.internal`
- **Keycloak SSO**: `https://sso.local.beluga.internal` — Trino OAuth2(Task 16)의 `oauth2.issuer`가 이 호스트명이라, 브라우저/클라이언트가 토큰 발급·리다이렉트를 위해 이 이름을 반드시 해석할 수 있어야 한다.

## 개발 규약 요약

1. **단일 진실 원천 (Single Source of Truth)**
   - 모든 이미지/컴포넌트 버전은 [VERSIONS.md](VERSIONS.md) 하나에서 관리한다.
2. **검증 규율 ("Never fabricate state")**
   - 모든 검증은 [tests/](tests) 하위의 스크립트로 실상태를 조회해 확인한다.
3. **커밋 규약 (Conventional Commits)**
   - 브랜치 타입: `feat/`, `fix/`, `chore/`
   - 커밋 형식: `<type>(<module>): <desc>` (module: `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, `docs`)
   - 로컬 커밋 전용 (push 금지).
4. **클러스터 검증 규율** (반복 재발 이력: [docs/mistakes-log.md](docs/mistakes-log.md) 2026-08-25 항목)
   - 이 머신은 다수의 동시 세션이 공유한다 — 작업 전 `kubectl --context=beluga config view --minify --flatten > /tmp/beluga-kubeconfig.yaml`로 격리된 kubeconfig를 만들고, 이후 모든 `kubectl`/`helm` 호출에 `KUBECONFIG=/tmp/beluga-kubeconfig.yaml`을 붙인다. 공유 `~/.kube/config`는 건드리지 않는다.
   - `beluga-platform`/`beluga-data` Application은 `selfHeal: true`다 — 실제 반영은 커밋+푸시 후 ArgoCD 동기화로 확인한다. 푸시 없는 `kubectl apply`는 곧 조용히 되돌려진다.
   - ConfigMap만 바꾼 뒤에는 관련 Deployment에 `kubectl rollout restart`를 명시적으로 호출한다(K8s는 자동 재시작하지 않는다).
   - 네임스페이스를 넘는 서비스 참조는 짧은 이름이 아니라 `<service>.<namespace>.svc.cluster.local` FQDN을 쓴다.
   - 게이트웨이·인증 관련 변경은 컴포넌트 **직접 접근**과 **문서화된 실제 진입점(도메인 레지스트리) 경유** 둘 다 실측해야 완료로 인정한다.

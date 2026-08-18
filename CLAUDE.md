# Beluga — Project Source Map & Rules

Beluga는 Vagrant 독립 K8s 클러스터 위에 구축하는 풀스택 데이터 플랫폼이다.

## Source Map

- **전체 플랫폼 설계서**: [docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md)
- **버전 단일 원천 (Single Source of Truth)**: [VERSIONS.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/VERSIONS.md)
- **클러스터 환경 변수**: [configs/cluster.env](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/configs/cluster.env)
- **실수 기록 (Mistakes Log)**: [docs/mistakes-log.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/mistakes-log.md)
- **구현 계획서**: [docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md)
- **라이선스 · 서드파티 고지**: [LICENSE](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/LICENSE) (Apache-2.0), [NOTICE](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/NOTICE) — 배포 컴포넌트별 라이선스는 VERSIONS.md의 "라이선스" 열이 원천. 실행 중 클러스터의 SBOM은 `bash scripts/generate-sbom.sh`로 생성.

## 도메인 레지스트리 (`*.local.beluga.internal` — Unified Port 80)

호스트 `/etc/hosts` 설정:
```text
127.0.0.1 trino.local.beluga.internal airflow.local.beluga.internal superset.local.beluga.internal catalog.local.beluga.internal s3.local.beluga.internal argocd.local.beluga.internal
```

- **Trino UI**: `http://trino.local.beluga.internal`
- **Airflow UI**: `http://airflow.local.beluga.internal`
- **Superset UI**: `http://superset.local.beluga.internal`
- **Lakekeeper REST**: `http://catalog.local.beluga.internal`
- **SeaweedFS S3**: `http://s3.local.beluga.internal`
- **ArgoCD UI**: `http://argocd.local.beluga.internal`

## 개발 규약 요약

1. **단일 진실 원천 (Single Source of Truth)**
   - 모든 이미지/컴포넌트 버전은 [VERSIONS.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/VERSIONS.md) 하나에서 관리한다.
2. **검증 규율 ("Never fabricate state")**
   - 모든 검증은 [tests/](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/tests) 하위의 스크립트로 실상태를 조회해 확인한다.
3. **커밋 규약 (Conventional Commits)**
   - 브랜치 타입: `feat/`, `fix/`, `chore/`
   - 커밋 형식: `<type>(<module>): <desc>` (module: `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, `docs`)
   - 로컬 커밋 전용 (push 금지).

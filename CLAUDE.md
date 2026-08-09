# Beluga — Project Source Map & Rules

Beluga는 Vagrant 독립 K8s 클러스터 위에 구축하는 풀스택 데이터 플랫폼이다.

## Source Map

- **전체 플랫폼 설계서**: [docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md)
- **버전 단일 원천 (Single Source of Truth)**: [VERSIONS.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/VERSIONS.md)
- **클러스터 환경 변수**: [configs/cluster.env](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/configs/cluster.env)
- **실수 기록 (Mistakes Log)**: [docs/mistakes-log.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/mistakes-log.md)
- **구현 계획서**: [docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/docs/superpowers/plans/2026-08-10-beluga-implementation-plan.md)

## 도메인 레지스트리 (`*.beluga.local`)

호스트 `/etc/hosts` 설정:
```text
127.0.0.1 trino.beluga.local airflow.beluga.local superset.beluga.local catalog.beluga.local s3.beluga.local argocd.beluga.local
```

- **Trino UI**: `http://trino.beluga.local:8080`
- **Airflow UI**: `http://airflow.beluga.local:8085`
- **Superset UI**: `http://superset.beluga.local:8088`
- **Lakekeeper REST**: `http://catalog.beluga.local:8181`
- **SeaweedFS S3**: `http://s3.beluga.local:8333`
- **ArgoCD UI**: `https://argocd.beluga.local:8443`

## 개발 규약 요약

1. **단일 진실 원천 (Single Source of Truth)**
   - 모든 이미지/컴포넌트 버전은 [VERSIONS.md](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/VERSIONS.md) 하나에서 관리한다.
2. **검증 규율 ("Never fabricate state")**
   - 모든 검증은 [tests/](file:///Users/m/Documents/IdeaProjects/20.dasomel/beluga/tests) 하위의 스크립트로 실상태를 조회해 확인한다.
3. **커밋 규약 (Conventional Commits)**
   - 브랜치 타입: `feat/`, `fix/`, `chore/`
   - 커밋 형식: `<type>(<module>): <desc>` (module: `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, `docs`)
   - 로컬 커밋 전용 (push 금지).

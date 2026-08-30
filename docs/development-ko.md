# 개발 가이드 (Development Guide)

[English](development.md) | 한국어

로컬 개발과 기여 절차를 다룬다. 기여 워크플로와 커밋 규약은
[CONTRIBUTING-ko.md](../CONTRIBUTING-ko.md)를 참고하고, 이 문서는 명령어 표면과
검증 레벨에 집중한다.

## 명령어 표면

```text
make up       # 전체 클러스터 기동 + GitOps 부트스트랩 (bash scripts/up.sh)
make status   # VM 및 K8s 파드 상태 확인
make test     # tests/run-all.sh — 실상태 E2E 검증 (라이브 클러스터 필요)
make lint     # shellcheck (scripts/, tests/, demo/) + helm lint
make validate # 정적 매니페스트/YAML 검증 — 클러스터 불필요
make down     # vagrant destroy -f
make clean    # .kube/ 캐시 삭제
```

## 검증 레벨

무언가 동작한다고 보고할 때는 세 레벨을 구분한다 —
[AGENTS.md](../AGENTS.md)의 evidence-first 원칙이 이를 뒷받침한다.

1. **정적 검증** (`make lint`, `make validate`) — shellcheck, `helm lint`,
   `helm template` 렌더, YAML 문법 검사. 매니페스트가 문법적으로 올바름을
   증명할 뿐 런타임 동작은 증명하지 않는다. CI가 매 PR마다 실행하는 것이 이
   레벨이다([.github/workflows/ci.yml](../.github/workflows/ci.yml)).
2. **라이브 E2E** (`make test`) — `tests/01-cluster-health.sh`부터
   `tests/10-tls-identity-boundary.sh`까지(그리고 별도 실행하는
   `tests/06-authz-defaults.sh`)가 실제 클러스터 상태(파드 헬스, Kafka/CDC 흐름,
   Iceberg 테이블, Trino 쿼리, Airflow DAG, authz 기본값, TLS/identity 경계)를
   조회한다. 기동된 클러스터가 필요해 GitHub Actions에서는 실행할 수 없다. 유일한
   예외는 `tests/11-identity-plaintext-preflight.sh`다 — `helm template`으로 렌더한
   결과만 정적으로 검사해 평문 identity 엔드포인트 노출 여부를 확인하므로 라이브
   클러스터가 필요 없고 로컬에서 클러스터 없이 통과한다.
3. **수동 게이트웨이/인증 검증** — 인증·게이트웨이 변경은 컴포넌트 직접 접근과
   문서화된 사용자 진입점(APISIX 게이트웨이 도메인 레지스트리) 둘 다로
   검증한다. 이 구분이 왜 중요한지는
   [docs/mistakes-log.md](mistakes-log.md)의 2026-08-25 `orch` 항목을 참고.

"렌더/lint 통과"와 "실제로 동작"은 다른 주장이다. 완료를 보고할 때 둘을 섞지
않는다.

## 환경 변수

- `configs/cluster.env` — 커밋된, 비밀이 아닌 클러스터 토폴로지(서브넷, 노드 IP,
  도메인 레지스트리). 토폴로지 변경은 직접 수정한다.
- `.env.example` — `scripts/common/env.sh`가 존중하는 선택적 셸 환경변수
  오버라이드(RAM 프로파일 오버라이드, `KUBECONFIG` 경로)의 정제된 템플릿.
  여기든 리포 어디든 실제 시크릿을 추가하지 않는다.
- 이 머신은 다수의 동시 Kubernetes 세션이 돈다. `beluga` 컨텍스트를 건드리기
  전 항상 격리된 kubeconfig를 만든다 — [CLAUDE.md](../CLAUDE.md) 참고.

## 시작 전에

순서대로 읽는다: [AGENTS.md](../AGENTS.md) -> [CLAUDE.md](../CLAUDE.md) ->
[README-ko.md](../README-ko.md) -> [VERSIONS.md](../VERSIONS.md) ->
[docs/mistakes-log.md](mistakes-log.md) -> `docs/superpowers/` 아래 관련
아키텍처/설계 문서 -> 구현하려는 이슈/스펙.

# Beluga 기여 가이드 (Contributing Guide)

[English](CONTRIBUTING.md) | 한국어

Beluga는 개인/학습 스케일의 IaC 데이터 플랫폼이다. 이 문서는 Vagrant/K8s/GitOps/정책
레이어를 수정하려는 사람을 위한 로컬 개발 가이드다.

## 사전 준비물

- Vagrant, `kubectl`, `helm`
- `configs/cluster.env` 기준 VMware Fusion(arm64) 또는 VirtualBox(amd64)
- lint 워크플로용 `shellcheck` (`make lint`)
- 호스트 RAM 32GB 이상 ([README-ko.md](README-ko.md#요구-사항) 참고)

## 로컬 개발

```bash
make up       # 전체 클러스터 기동 + GitOps 부트스트랩
make status   # VM 및 파드 상태 확인
make test     # tests/ E2E 검증 스크립트 실행 (라이브 클러스터 필요)
make lint     # shellcheck + helm lint
make validate # 정적 매니페스트/YAML 검증 (클러스터 불필요)
make down     # VM 전체 삭제
```

## 기여 지침

- 편집 전에 [AGENTS.md](AGENTS.md)와 [CLAUDE.md](CLAUDE.md)를 먼저 읽는다 — 범위
  규율, 버전 단일 원천(`VERSIONS.md`), 공유 클러스터 안전 규칙, GitOps self-heal
  동작을 다룬다.
- 클러스터 부트스트랩, GitOps 동기화, 인증/게이트웨이 경로를 건드리기 전에
  [docs/mistakes-log.md](docs/mistakes-log.md)의 기존 실패 유형을 읽는다.
- GitOps 소유권 경계와 `VERSIONS.md` 버전 단일 원천을 보존한다. 컴포넌트 버전,
  GitOps 소유권, 인증/게이트웨이, RBAC 변경은 설계 변경이다 — PR에서 명시적으로
  밝힌다.
- 버그 수정: 재현 -> 실패 증거 확보 -> 최소 수정 -> 같은 증거로 통과 확인 ->
  관련 회귀 스위트(`tests/`) 실행.
- 정적/매니페스트 검증(`make lint`, `make validate`)과 실제 클러스터 검증
  (`make test`)을 구분해 어느 쪽을 실행했는지 명시한다.
- 실제 자격증명은 절대 커밋하지 않는다 — [SECURITY-ko.md](SECURITY-ko.md)와
  [.env.example](.env.example) 참고.

## 커밋 규약

Conventional Commits: `<type>(<module>): <설명>` — `type`은 `feat`/`fix`/`chore`/`docs`
중 하나, `module`은 `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`,
`orch`, `demo`, `docs` 중 하나.

## Pull Request

[.github/pull_request_template.md](.github/pull_request_template.md)를 사용한다.
관련 이슈를 링크하고, 실행한 테스트를 서술하며, 워크플로/런타임/툴체인 영향이
있으면 명시한다.

# ADR-0001: Vagrant + k3s + ArgoCD GitOps 플랫폼 아키텍처

- Status: Accepted
- Date: 2026-08-09
- Supersedes: —
- Superseded by: —

## 배경

Beluga는 어떤 바이너리도 빌드·벤더링하지 않고, 같은 호스트의 다른 동시 세션이
건드릴 수 있는 공유/관리형 클러스터에도 의존하지 않으면서, 전체 데이터 플랫폼
(Kafka/CDC, Flink, Iceberg, Trino, Airflow)을 올릴 독립적이고 재현 가능한 로컬
Kubernetes 클러스터가 필요하다.

## 결정

`Vagrantfile`로 VM 4대(master 1 + worker 3)를 프로비저닝하고, `scripts/cluster/*.sh`로
k3s를 설치한 뒤, 직접 `helm install`/`kubectl apply` 대신 ArgoCD app-of-apps
GitOps(`gitops/apps/` -> `gitops/charts/beluga-platform` +
`gitops/charts/beluga-data`)로 전체 애플리케이션 스택을 배포한다. 모든 컴포넌트
이미지는 배포 시점에 각자의 업스트림 레지스트리에서 받아오며, 버전은
`VERSIONS.md`에서 중앙 관리한다.

## 검토한 대안

- **관리형/공유 클러스터**(예: 여러 동시 세션이 공유하는 단일 kind/k3d 클러스터)
  — 기각: 이 호스트는 다른 리포에서 동시에 20개 이상의 Claude 세션이 돈다 —
  공유 클러스터 컨텍스트가 상태를 뒤섞는 혼란의 실증된 원인이었다
  (`docs/mistakes-log.md`의 2026-08-25 `harness` 항목 참고).
- **GitOps 없는 직접 `helm install`/`kubectl apply`** — 기각: 재조정(reconciliation)이나
  드리프트 감지가 없어, 수동 명령형 변경이 여러 주에 걸친 프로젝트 동안 커밋된
  단일 원천과 소리 없이 갈라진다.
- **Kubernetes 대신 Docker Compose** — 기각: 목표 컴포넌트 다수(Strimzi, Flink
  Kubernetes Operator, cert-manager)가 Kubernetes 오퍼레이터 네이티브라 이
  프로젝트가 유지하고 싶은 비-Kubernetes 대응 배포 모델이 없다.

## 근거

Vagrant VM은 세션/호스트별로 격리된 클러스터 경계를 준다. k3s는 노트북급
호스트에서 빠르게 뜨는 가볍고 잘 지원되는 배포판이다. ArgoCD GitOps는 "실제로
무엇이 떠 있는가"를 커밋된 매니페스트만으로 재구성 가능하게 하고, 그
`selfHeal: true` 동작은 우발적인 수동 드리프트를 소리 없는 사건이 아니라 눈에
보이고 고칠 수 있는 사건으로 바꾼다.

## 결과

### 긍정적

- 클러스터 상태가 `git clone` + `make up`으로 재현 가능하다.
- GitOps self-heal이 우발적인 명령형 드리프트를 잡아낸다.
- 호스트의 다른 동시 세션과 공유 클러스터 간섭이 없다.

### 부정적 / 트레이드오프

- VM 4대 풋프린트는 호스트 RAM 32GB 이상을 요구한다 — 가벼운 로컬 개발 경험이
  아니다.
- `selfHeal: true`는 빠른 검증용으로만 쓴 `kubectl apply`가 실제 커밋+푸시 없이는
  몇 분 안에 소리 없이 되돌려짐을 뜻한다 — 이는 반복적으로 디버깅 시간을
  소모시켰고(`docs/mistakes-log.md`의 2026-08-25 `gitops` 항목 참고), 이 결정의
  직접적인 결과로 `CLAUDE.md`에 명시된 주의 사항이다.

## 영향받는 표준·템플릿·프로젝트

- `Vagrantfile`, `scripts/cluster/`, `scripts/gitops/`, `gitops/`
- `docs/architecture.md`, `CLAUDE.md`

## 마이그레이션 / 도입

해당 없음 — 원래 아키텍처를 OpenForge 컴플라이언스 베이스라인 도입(2026-08)의
일환으로 소급 기록한 것이다.

## 근거 자료

- 설계 원본: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md`
- 운영 증거: `docs/mistakes-log.md` (다수의 `gitops`/`harness` 항목)
- 관련 ADR: ADR-0002

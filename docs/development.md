# Beluga 개발 가이드

## 준비 사항

Beluga는 Vagrant와 `scripts/up.sh`가 선택하는 Vagrant provider가 필요하다. `configs/cluster.env`의 `VAGRANT_PROVIDER`로 VMware Fusion(arm64) 또는 VirtualBox(amd64)를 선택한다. 호스트에는 Vagrant, `kubectl`, `helm`이 필요하다. 기본 구성은 master-1과 worker-1~3의 네 VM을 기동하므로 README의 RAM·디스크 요구 사항도 먼저 확인한다.

## 클러스터 기동

리포 루트에서 다음을 실행한다.

```bash
bash scripts/up.sh
```

`scripts/up.sh`는 RAM 프로파일을 감지하고, Vagrant VM 기동, 노드 준비와 k3s 초기화, Cilium·MetalLB 설치, 로컬 DNS 설정, ArgoCD·GitOps 부트스트랩을 순서대로 수행한다. `make up`은 이 스크립트의 래퍼다.

## 공유 머신의 kubeconfig 격리

이 머신의 kubeconfig는 동시 세션이 공유한다. 작업 전에 `beluga` 컨텍스트만 포함한 임시 파일을 만들고, 이후 **모든** `kubectl`·`helm` 호출에 그 파일을 명시한다. 공유 `~/.kube/config`는 변경하지 않는다.

```bash
kubectl --context=beluga config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
KUBECONFIG=/tmp/beluga-kubeconfig.yaml kubectl get nodes
KUBECONFIG=/tmp/beluga-kubeconfig.yaml helm list -A
```

프로젝트 로컬 kubeconfig가 필요하면 `bash scripts/kubeconfig.sh`로 `.kube/config`를 생성한다. 공유 환경에서의 클러스터 검증에는 위의 격리 규칙을 우선한다.

## 테스트

전체 E2E 묶음은 다음과 같다.

```bash
bash tests/run-all.sh
# 또는 make test
```

`run-all.sh`는 01~05와 07~12를 실행하며, 06은 별도 실행한다. 아래 설명은 파일명 기준이다.

| 스크립트 | 파일명 기준 대상 |
|----------|----------------|
| `01-cluster-health.sh` | 클러스터 상태 |
| `02-ingest-cdc.sh` | 수집·CDC |
| `03-stream-iceberg.sh` | 스트림·Iceberg |
| `04-trino-query.sh` | Trino 쿼리 |
| `05-airflow-dag.sh` | Airflow DAG |
| `06-authz-defaults.sh` | 기본 인가 정책 — `run-all.sh`에 포함되지 않음 |
| `07-trino-authz-live.sh` | Trino 실시간 인가 |
| `08-apisix-admin-restrict.sh` | APISIX 관리자 제한 |
| `09-seaweedfs-authz-live.sh` | SeaweedFS 실시간 인가 |
| `10-tls-identity-boundary.sh` | TLS ID 경계 |
| `11-identity-plaintext-preflight.sh` | ID 평문 사전 점검 |
| `12-gateway-route-consistency.sh` | 게이트웨이 라우트 일관성 |

## 브랜치와 커밋

`CLAUDE.md`의 규약을 따른다.

- 브랜치 타입은 `feat/`, `fix/`, `chore/`이다.
- 커밋은 Conventional Commits 형식인 `<type>(<module>): <desc>`를 쓴다.
- 허용 모듈은 `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, `docs`다.
- 실제 커밋 이력에는 추가 타입 접두사 `security(...)`, `test(...)`도 있다.
- **로컬 커밋 전용이며 push는 금지**한다.

`.github/workflows` 디렉터리는 현재 없다. 따라서 이 리포에 없는 CI/CD, PR 검토 절차, 릴리스 주기를 가정하거나 문서화하지 않는다.

## GitOps와 재시작 주의점

`beluga-platform`과 `beluga-data` ArgoCD Application은 `selfHeal: true`다. 푸시 없는 수동 `kubectl apply`는 GitOps 상태와 다르면 곧 되돌아갈 수 있다. 실제 반영은 커밋과 푸시 뒤 ArgoCD 동기화로 확인해야 한다는 규칙이지만, 이 리포의 로컬-커밋 전용 정책을 벗어나는 push는 명시 요청 없이는 수행하지 않는다.

ConfigMap만 변경하면 Kubernetes가 관련 Deployment를 자동 재시작하지 않는다. 필요한 Deployment에는 명시적으로 `kubectl rollout restart`를 실행한다. 게이트웨이·인증 변경은 컴포넌트 직접 접근과 도메인 레지스트리에 문서화된 실제 진입 경로를 모두 검증한다.

# 릴리스 가이드 (Releasing)

[English](RELEASING.md) | 한국어

Beluga는 아직 태그 릴리스를 낸 적이 없다 — 이 문서는 릴리스 시점의 절차를
정의해둔다.

## 버전 관리

Beluga 자체는 버전화된 산출물을 배포하지 않는다(배포 시점에 업스트림 컴포넌트
이미지를 그대로 받아오는 IaC이기 때문). 릴리스를 낼 때는 특정 컴포넌트가 아니라
플랫폼 정의 상태를 Semantic Versioning(`vMAJOR.MINOR.PATCH`)으로 태그한다.

컴포넌트/이미지 버전은 리포 태그와 무관하게 항상 [VERSIONS.md](VERSIONS.md)가
단일 원천이다.

## 릴리스 절차

1. `main`이 green 상태인지 확인: CI에서 `make lint`와 `make validate`가 통과
   ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
2. `VERSIONS.md`가 실제 배포 이미지를 정확히 반영하는지 확인(선언값과
   `values.yaml` 참조 이미지 간 드리프트 없음).
3. [CHANGELOG.md](CHANGELOG.md)와 [CHANGELOG-ko.md](CHANGELOG-ko.md)를 갱신해
   `[Unreleased]` 항목을 신규 버전 헤딩 아래로 이동한다.
4. 커밋에 태그: `git tag -a vX.Y.Z -m "vX.Y.Z"` 후 태그를 푸시한다.
5. 배포 컴포넌트 버전이 바뀌었다면 라이브 클러스터에서
   `bash scripts/generate-sbom.sh`를 다시 실행해 산출물을 릴리스 노트와 함께
   보관한다(SBOM 절차는 [NOTICE](NOTICE) 참고).

## 롤백

Beluga는 적용 시점에 받아오는 선언적 매니페스트 외에는 아무것도 배포하지 않으므로,
롤백은 문제 커밋에 대한 `git revert` 후 ArgoCD 동기화가 전부다 — 별도로 롤백할
바이너리 산출물이 없다. 클러스터 측 롤백 세부 사항(`StatefulSet` 재생성 시 PVC
데이터 유실 위험, ArgoCD `selfHeal`과의 상호작용)은 사건별로
[docs/mistakes-log.md](docs/mistakes-log.md)에 기록한다.

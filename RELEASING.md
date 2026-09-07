# 배포 변경 절차

이 저장소는 GitHub Release, 시맨틱 버전 태그, CI/CD 워크플로를 사용하지 않는다. `.github/workflows` 디렉터리가 없으며, 배포 상태는 원격 `main`의 GitOps 매니페스트와 ArgoCD 동기화 결과로 결정된다.

## 버전 기록

[VERSIONS.md](VERSIONS.md)는 배포 컴포넌트 버전·이미지·라이선스의 단일 원천이다. 컴포넌트 버전을 바꿀 때 매니페스트와 함께 갱신한다. 이 변경과 이를 설명하는 로컬 커밋이 이 저장소의 릴리스 기록이다.

## 로컬 커밋과 반영

CLAUDE.md의 Conventional Commits 규약을 따른다: 브랜치 타입은 `feat/`, `fix/`, `chore/`; 형식은 `<type>(<module>): <desc>`; 모듈은 `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, `docs`다. 기본 작업은 로컬 커밋까지만이며 자동 push는 금지한다.

`origin/main` push는 사용자의 명시적 요청이 있을 때만 수행한다. unpushed 로컬 커밋은 라이브 클러스터 상태가 아니다. push된 매니페스트는 ArgoCD의 `beluga-platform`과 `beluga-data` Application이 동기화한다. 둘 다 `selfHeal: true`이므로 직접 적용한 변경은 원격 Git 상태로 되돌아갈 수 있다.

## 검증

커밋·명시적 push 후 ArgoCD 동기화 상태와 `tests/`의 실클러스터 검증 스크립트로 실제 반영을 확인한다. 정적 검사나 unpushed 커밋만으로 완료를 판단하지 않는다. 게이트웨이·인증 변경은 직접 접근과 문서화된 사용자 진입점을 모두 검증한다.


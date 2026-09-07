# 변경 이력 (Changelog)

[English](CHANGELOG.md) | 한국어

이 프로젝트의 주요 변경 사항을 이 파일에 기록한다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 기준으로 하며, 첫
태그 릴리스가 나오면 [Semantic Versioning](https://semver.org/lang/ko/)을 따를
예정이다. pre-1.0 단계에서는 `main`만 지원 대상이며, 버전별이 아니라 서술형으로
이력을 관리한다.

## [Unreleased]

### 추가

- 핵심 데이터 플랫폼: Kafka(+CDC) -> Flink -> Iceberg 레이크하우스 ->
  Trino/Superset -> Airflow, Vagrant + k3s + ArgoCD GitOps로 배포. 클린 인스톨
  E2E까지 검증 완료.
- 엔드투엔드 데모 2종: 합성 클릭스트림 이벤트 파이프라인, Postgres CDC 파이프라인.
- 부트스트랩 시점 랜덤 자격증명 생성 후 Kubernetes Secret 저장(리포에 자격증명
  커밋 없음 — [SECURITY-ko.md](SECURITY-ko.md) 참고).
- 라이브 클러스터 이미지 대상 SBOM 생성(`scripts/generate-sbom.sh`).
- OpenForge 컴플라이언스 베이스라인: 이중 언어 문서 세트, `docs/adr/`, GitHub
  템플릿, CI 워크플로(lint, 정적 검증, 문서/ADR 페어링 검사, 공급망 정책 검사,
  IaC 정적 분석).

### 진행 중

- 정책 컴파일러 통합(`policies/`의 선언 YAML을 Keycloak/Rego/PostgreSQL 산출물로
  컴파일) — 컴파일러 자체는 companion 리포에서 구현 완료, 이 클러스터에 실제
  배포·검증하는 단계(Trino LDAP 그룹 프로바이더, 정책 컷오버, Superset 롤 매핑,
  카탈로그 브라우징 갭)는 아직 남아 있음.

개발 중 발견·수정한 결함의 상세하고 날짜별인 기록은
[docs/mistakes-log.md](docs/mistakes-log.md)를 참고한다.

[Unreleased]: https://github.com/dasomel/beluga/commits/main

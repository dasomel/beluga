# Beluga Mistakes Log

작업 중 발생한 실패, 오개념, 설정 오류 및 디버깅 경험을 기록하여 재발을 방지한다.

## 원칙
1. 작업 시작 전 해당 영역의 기존 기록을 읽는다.
2. 새 오류 발생 시 아래 표에 행을 추가한다.

---

## 기록 표

| 날짜 | 영역 | 원인 / 현상 | 해결 / 예방책 |
|------|------|-------------|---------------|
| 2026-08-10 | docs | write_to_file 도구 호출 시 ArtifactMetadata 포함으로 인한 경로 오류 | 프로젝트 코드/문서 작성 시에는 ArtifactMetadata 파라미터 제외 |
| 2026-08-10 | lake | VERSIONS.md에 "Lakekeeper 0.7.0"으로 기록했으나 실제 배포 이미지는 `tabulario/iceberg-rest:latest` — 컴포넌트 자체가 다르고(D4 위반) 태그도 미고정. 문서와 배포가 소리 없이 갈라진 상태로 커밋됨 | VERSIONS.md를 실제 배포 기준으로 정정하고 D4 불일치를 §9 리스크·백로그에 명시. 예방: 컴포넌트 행 추가 시 values.yaml의 image 값과 대조하고, tests/에 VERSIONS.md↔values 드리프트 검증 추가 예정 |
| 2026-08-10 | gitops | nginx Ingress → APISIX 전환 중 토큰 소진으로 중단 — 03-cni-metallb.sh에 ingress-nginx 설치가 잔존하고 Flink 라우트 누락 등 반쪽 전환 상태가 워킹트리에 방치됨 | 전환 마무리 커밋으로 정리 (nginx 설치 제거, Flink 라우트 추가). 예방: 아키텍처 전환은 시작 전에 대상 파일 목록을 만들어 한 커밋 단위로 완결하고, 중단 시 핸드오프에 미완료 목록을 남긴다 |

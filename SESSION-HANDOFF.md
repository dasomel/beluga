# Beluga Session Handoff — 2026-08-10

새 세션에서 이 파일부터 읽고 이어서 진행할 것.

## 현재 상태

**설계서 D1~D14 확정. 전체 스택 1차 구현 존재(다른 세션이 agy로 작업), APISIX 전환 마무리·거버넌스 스펙 반영 완료.**

- 설계서: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md` — 결정은 전부 §2 D-레지스트리
- 구현 현황: Vagrantfile + scripts/ + gitops/charts/{beluga-platform,beluga-data} + demo/ + tests/ 존재
  (커밋 `6ed2a49`~). 단 **클린 인스톨 검증(`vagrant up` 전체 사이클)은 아직 미실행** — 상태 단정 금지
- 접근 방식: APISIX 게이트웨이 + MetalLB `.200` — 전 HTTP UI `*.local.beluga.internal:80` (D11),
  Kafka만 호스트 9094. 상세는 `docs/access-guide.md`

## 다음 단계 (순서대로)

1. **거버넌스 구현 레인** (D12~D14, 스펙만 반영됨 — 코드 없음): Keycloak + 중앙 OPA +
   OpenFGA 매니페스트/차트, OpenMetadata(48GB+ 프로파일 게이트), 각 UI OIDC 연동
2. **Lakekeeper 교체 백로그** (D4 불일치): `tabulario/iceberg-rest:latest` → 실제 Lakekeeper
   이미지 + 환경변수 체계 전환 (VERSIONS.md·mistakes-log 참조)
3. **클린 인스톨 E2E**: `vagrant up` → tests/run-all.sh — §8 검증 기준 1~11 확인
4. D8 프로파일 로직(up.sh RAM 감지)이 32GB/48GB+ 분기(Trino worker, OpenMetadata)를
   실제 반영하는지 확인

## 프로젝트 한 줄 요약

Vagrant 독립 K8s 클러스터(마스터1×4GB + 워커3×8GB, 서브넷 192.168.77.x) 위 풀스택
데이터 플랫폼 — Strimzi Kafka(KRaft) + Flink + Iceberg + Trino + Superset + Airflow 3 + CNPG
+ 자체 APISIX 게이트웨이 + 거버넌스(Keycloak SSO / 중앙 OPA + OpenFGA / OpenMetadata).
데모는 이벤트 스트리밍 + CDC + 거버넌스. narwhal(IDP)·kubemetal(MLOps)에 이은 3부작.
상세·근거는 전부 설계서 §2 D-레지스트리에 있음.

## 실행 규약 (D10)

Fable 지휘 오케스트레이션 + agy 워커 적극 활용 (Agent Team Harness) — 라우팅 표는 설계서
§7 "에이전트 실행 체계". 기계적 구현은 워커 레인으로, D-레지스트리 변경·리뷰 승인은 Fable 직접.

## 참조 경로

| 무엇 | 어디 |
|------|------|
| 자매 프로젝트 (컨벤션 원본) | `~/Documents/IdeaProjects/20.dasomel/idp/narwhal` (Vagrant/GitOps 골격), `20.dasomel/kubemetal` (CLAUDE.md 규약 패턴) |
| narwhal GitOps 레이아웃 | `narwhal/gitops/apps/app-of-apps.yaml` + `charts/{narwhal-platform,narwhal-apps}` — beluga가 미러링한 구조 |
| 접근 가이드 (URL·자격증명) | `docs/access-guide.md` |
| 실수 기록 | `docs/mistakes-log.md` — 작업 영역 기록을 먼저 읽을 것 |

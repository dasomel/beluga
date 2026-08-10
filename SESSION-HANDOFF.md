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

1. **클린 인스톨 E2E**: `vagrant up`(scripts/up.sh) → tests/run-all.sh — §8 검증 기준 1~11.
   특히 실검증 필요: sso.* 도메인의 파드 내 해석(CoreDNS→dnsmasq 포워드), Superset OIDC
   롤 매핑, Lakekeeper 부트스트랩 Job, Trino /catalog URI
2. **후속 백로그**: opa-kafka-plugin JAR 커스텀 Kafka 이미지(현재 strimzi.opaAuthorizer=false),
   OpenFGA 영속화(현재 in-memory) + Lakekeeper openfga.enabled 활성, OM ingestion CronJob,
   Airflow 롤 매핑(#54098 해소 시), Grafana/Prometheus 도메인 편입
3. tests/에 VERSIONS.md↔values 이미지 드리프트 검증 + 이미지 arm64 manifest 게이트 스크립트 추가

거버넌스 구현(1차: 컴포넌트, 2차: OIDC 와이어링·부트스트랩·D8 프로파일 연동)은 완료 —
`git log` 참조. 신규 이미지는 전부 manifest inspect로 arm64 확인됨.

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

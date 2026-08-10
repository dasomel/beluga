# Beluga Session Handoff — 2026-08-10

새 세션에서 이 파일부터 읽고 이어서 진행할 것.

## 현재 상태

**클린 인스톨 E2E 1차 완료 — 전 파드 Running + 강화된 tests/run-all.sh 전체 통과 (exit 0).**
런타임 실측으로 결함 ~17건을 잡아 수정·커밋함 (mistakes-log 2026-08-10 참조 — 프로브 오설정,
Strimzi 4중 사슬, CDC 5중 사슬, PG 권한, arm64 이미지 허위 검증 등).

- 설계서: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md` — D1~D15 확정, D6·D11 E2E 반영 수정
- 클러스터: k3s v1.36 (채널 고정), Strimzi 1.1.0 + Kafka 4.3.0 KRaft 3노드,
  CDC = 독립 Debezium Connect + shop-cdc 커넥터 RUNNING + `cdc.shop.*` 토픽 실검증
- **D16 확정 (2026-08-10 승인)**: K8s 배포판 = k3s (채널 고정) — 설계서 §1·D-레지스트리 반영 완료

## §8 검증 기준 결산 (2026-08-10 E2E 1차)

| 기준 | 상태 |
|------|------|
| 1. 전 파드 Running | ✅ 통과 (스위트 01, 하드 게이트) |
| 2. 이벤트 데모→Superset | ⬜ 미검증 — clickstream-gen·Flink SQL 잡 배포 메커니즘 자체 미구현 의심 (CDC 시딩·커넥터 등록도 부재였음) |
| 3. CDC→Iceberg 미러 | 🔶 부분 — Debezium→Kafka까지 실검증(토픽·스냅숏), Flink→Iceberg 미검증 |
| 4. Trino 타임트래블 | ⬜ 미검증 (스위트 04는 파드 수준) |
| 5. Airflow DAG 이력 | ⬜ 미검증 (DAG 배포 메커니즘 확인 필요) |
| 6. lint/테스트 통과 | 🔶 shellcheck·helm lint ✅ / kubeconform 미설치·pytest 미실행 |
| 7. tests/ 실상태 조회 | 🔶 01·02는 실질(하드 게이트+REST/토픽 실조회), 03~05는 파드 수준 — 강화 필요 |
| 8. 도메인 :80 응답 | ⬜ 미검증 (APISIX Running, 라우팅 E2E 미확인) |
| 9. SSO 로그인+롤 매핑 | ⬜ 미검증 (Keycloak Running·realm import 성공까지 확인) |
| 10. OPA 허용/거부 관측 | ⬜ 미검증 (Rego 단위 검증만 — opa eval 4케이스 통과) |
| 11. OM 리니지 (48GB+) | ⬜ 미검증 (OM·OpenSearch Running까지) |

## 다음 단계 (순서대로)

1. **데모 파이프라인 완결**: clickstream-gen Deployment·Flink SQL 잡 제출·Airflow DAG 배포
   메커니즘 구현 여부 확인 → 부재 시 구현 (CDC에서 시딩·등록 부재였던 패턴과 동일할 가능성)
2. **기준 2~5, 8~11 실검증**: tests/ 03~05 실질화 + 거버넌스 검증 스크립트(§5 데모 ③) 추가
3. **후속 백로그**: opa-kafka-plugin JAR 커스텀 이미지, OpenFGA 영속화+활성, OM ingestion
   CronJob, Airflow 롤 매핑(#54098), Grafana/Prometheus 도메인 편입,
   tests/에 VERSIONS↔values 드리프트 + 이미지 arm64 manifest 게이트 스크립트

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

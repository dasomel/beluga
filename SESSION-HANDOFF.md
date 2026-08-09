# Beluga Session Handoff — 2026-08-09

새 세션에서 이 파일부터 읽고 이어서 진행할 것.

## 현재 상태

**브레인스토밍 완료 → 설계서 승인·커밋됨. 다음 단계 = 구현 계획 수립.**

- 설계서: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md` (커밋 `1467aa5`)
- 리포는 방금 `git init`한 상태 — 설계서와 이 핸드오프 외에 코드 없음
- 사용자가 설계서 최종 검토를 마치지 않았을 수 있음 — **재개 시 스펙 검토 완료 여부부터 확인**

## 다음 단계 (순서대로)

1. 사용자에게 스펙 검토 완료 여부 확인 (수정 요청 있으면 반영 후 재커밋)
2. `superpowers:writing-plans` 스킬 호출 → 구현 계획 작성
3. 계획 승인 후 구현 착수 (스캐폴딩: Vagrantfile, configs/cluster.env, scripts/up.sh, gitops app-of-apps 순이 자연스러움)

## 프로젝트 한 줄 요약

Vagrant 독립 K8s 클러스터(마스터1×4GB + 워커3×8GB, 서브넷 192.168.57.x) 위 풀스택
데이터 플랫폼 — Strimzi Kafka(KRaft) + Flink + Iceberg/Lakekeeper + SeaweedFS S3 +
Trino + Superset + Airflow 3 + CNPG. 데모는 이벤트 스트리밍 + CDC(Debezium) 복합.
narwhal(IDP)·kubemetal(MLOps)에 이은 3부작. 상세·근거는 전부 설계서 §2 D-레지스트리에 있음.

## 이 세션에서 결정된 것 (설계서에 모두 반영됨)

- 풀스택(스트리밍 포함) / 독립 신규 프로젝트 / 단독 구동 전제(32GB+) / 복합 데모(이벤트+CDC)
- 이름 **beluga** (narwhal 자매, 해양 테마)
- A안 채택: 표준 스택 (Spark 통합안 B, 경량 신세대안 C 기각)
- 규약 승계: kubemetal(Source Map, D-레지스트리, Mistakes Log, Never-fabricate-state,
  VERSIONS.md 단일 원천) + cloudbro(브랜치 3종 feat/fix/chore, 모듈 스코프 커밋,
  버그는 재현부터, 인프라용 테스트 표) — cloudbro의 DDD/PR-CI 강제는 과도 판단으로 제외
- 셀프 리뷰 수정 1건: Airflow 3 기본 포트 8080이 Trino와 겹쳐 호스트 포워드 8085로 재배정,
  포트 표 의미를 "호스트 port-forward 규약"으로 명확화
- **D10 (2026-08-09 추가)**: 구현 실행 체계 = Fable 지휘 오케스트레이션 + agy 워커 적극 활용
  (Agent Team Harness) — 상세 라우팅 표는 설계서 §7 "에이전트 실행 체계" 참조. 구현 단계의
  계획 실행(writing-plans 이후)도 이 하네스를 따를 것

## 참조 경로

| 무엇 | 어디 |
|------|------|
| 자매 프로젝트 (컨벤션 원본) | `~/Documents/IdeaProjects/20.dasomel/idp/narwhal` (Vagrant/GitOps 골격), `20.dasomel/kubemetal` (CLAUDE.md 규약 패턴) |
| 규약 참고한 외부 프로젝트 | `~/Documents/IdeaProjects/98.cloudbro/draft` (브랜치/커밋/테스트 전략) |
| narwhal GitOps 레이아웃 | `narwhal/gitops/apps/app-of-apps.yaml` + `charts/{narwhal-platform,narwhal-apps}` — beluga가 미러링할 구조 |

## 세션 앞부분 작업 (완료, 조치 불요)

- Claude Code 플러그인 22개 전체 업데이트 완료 (bkit 2.1.33, ciagent 0.16.2 등), 세션 재시작으로 적용됨
- OMC v4.15.7 최신 확인

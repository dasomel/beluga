# 제품 요구사항 및 사용자 시나리오 (초안)

- **상태**: 초안 — 이슈 #1, #2, #12, #13-#21, #41과 ADR-0001의 context 표에서 종합함. 이 문서
  자체가 설계 결정은 아니며, 아래 persona와 journey는 이미 등록된 UX 이슈에서 추론한 것이지
  새로운 제품 방향이 아니다. 확정 취급 전에 dasomel의 검토가 필요하다.
- **이슈**: [#2](https://github.com/dasomel/beluga-manager/issues/2)
- **상위 에픽**: #1

## 문제

Beluga Data Platform 운영자는 현재 Kafka, Flink, Trino, Iceberg(Lakekeeper 경유), Airflow,
Kubernetes 도구의 개별 UI를 오가며 "플랫폼이 건강한가, 아니라면 어디서 왜 문제인가"라는 하나의
질문에 답해야 한다. 이 시스템들 전반의 상태를 Beluga 고유의 Pipeline/Service/Data Asset 개념으로
상관관계화하는 단일 뷰가 없다. Beluga Manager는 그 상관관계 레이어가 되기 위해 존재한다 — 각
OSS UI로의 링크 모음 포털이 아니고, 어떤 OSS도 대체하지 않는다(#1의 핵심 차별화 원칙).

## Persona (등록된 UX 이슈에서 추론, 별도 소스 없음)

| Persona | 주요 뷰 | 대표 니즈 |
|---|---|---|
| **플랫폼/데이터 엔지니어** | Overview(#13), Services(#14), Pipelines(#16), Architecture(#18), Operations(#19) | "파이프라인이 처음부터 끝까지 건강한가, 특정 단계가 실패하면 어떤 리소스/이벤트/로그가 원인을 설명하는가?" |
| **데이터 분석가** | Data Catalog(#15), Query Workspace(#17) | "어떤 테이블이 있고 스키마가 뭔지, 그 맥락을 유지한 채 Trino로 들어갈 수 있는가?" |
| **플랫폼 관리자** | Security & Policy(#20), Safe Actions(#21) | "누가 무엇에 접근 가능한지, 원시 kubectl/API 호출이 아니라 감사 추적이 남는 통제된 운영 액션을 수행할 수 있는가?" |

한 사람이 여러 persona를 겸할 수 있다 — 이는 엄격한 접근 등급을 의도한 게 아니다(실제 RBAC
모델은 #20이 소유한다).

## 핵심 사용자 여정

1. **상태 확인 (Overview → Services)**: Overview에 진입해 플랫폼 전체 KPI/health 카드(#13)를
   보고, Beluga Manager를 벗어나지 않고 특정 저하된 서비스(#14)로 drill-down한다.
2. **파이프라인 트러블슈팅 (Pipelines → Architecture → Operations)**: 파이프라인 저하를
   감지하고(#16), 토폴로지를 조회해 실패 단계를 찾고(#18), 그 단계의 Kubernetes 리소스/이벤트/
   로그로 drill-down한다(#19) — 이슈 #41의 vertical slice(Kafka → Flink → Iceberg → Trino)가
   증명하려는 바로 그 end-to-end 여정이다.
3. **데이터 탐색에서 쿼리로 (Data Catalog → Query Workspace)**: catalog → schema → table →
   column을 탐색하고(#15), 그 테이블 맥락이 이미 로드된 채로 Query Workspace로 넘어간다(#17) —
   Trino 자체 UI에서 다시 찾을 필요 없이.
4. **통제된 액션 (Security & Policy → Safe Actions)**: 현재 롤/권한 상태를 확인한 뒤(#20),
   범위가 제한되고 확인 절차와 감사 기록이 있는 운영 액션을 수행한다(#21) — 확인 없는 직접
   변경은 절대 아니다.

모든 여정은 Beluga Manager 안에서 끝나거나 맥락을 유지한 채 전문 OSS UI로 넘어간다(#1의 "전문
기능은 기존 서비스 API/UI와 맥락을 유지한 채 연결한다" 원칙) — 그 전문 UI를 재구현할 필요는
전혀 없다.

## MVP 기능 우선순위

뷰 번호가 아니라 이슈 #41(첫 실행 가능한 vertical slice)과 ADR-0002의 최소 백엔드 범위가 실제로
요구하는 순서:

1. **Unified Service API**(#42) — Kafka, Flink, Iceberg, Trino, Airflow, Kubernetes의 health/
   version/capability. 이것 없이는 아무것도 만들 수 없다.
2. **Domain API 계약**(#43) — 나머지 전부가 소비하는 OpenAPI-first `/api/v1/*` 표면.
3. **Overview + Services 뷰**(#13, #14) — #42/#43이 있으면 가장 저렴하게 실제 화면이 됨; 이미
   mock 데이터 shell로 배포됨(`src/web/views/OverviewView.tsx`, `ServicesView.tsx`).
4. **Vertical slice 파이프라인 뷰**(#41, #16 일부) — Kafka→Flink→Iceberg→Trino를 하나의
   상관관계화된 Beluga Pipeline으로 증명. 개별 뷰가 아니라 이것이 MVP의 실제 성공 기준이다.
5. Data Catalog, Query Workspace, Architecture, Operations, Security, Safe Actions(#15, #17-#21)
   — vertical slice가 상관관계 모델이 동작함을 증명한 뒤, 기존 ADR-0001 뷰 표 순서대로.

## 명시적 범위 (#41과 #1에서)

**MVP 포함**: 읽기 전용 service/pipeline/data-asset 뷰; 명시적 provenance/confidence를 동반한
cross-service 상관관계, 검증 안 된 사실로 제시하지 않음(`docs/architecture.md` 원칙 6);
stale/degraded 상태를 숨기지 않고 명시적으로 표시; 맥락을 유지한 전문 OSS UI로의 hand-off.

**MVP 제외** (#41의 제외 목록, 여전히 유효): 모든 종류의 변경(mutating) 작업; 완성된 Data
Catalog(lineage, 전체 메타데이터 관리); 고급 lineage; 완전한 observability 제품(Beluga Manager는
health/event를 노출할 뿐 Prometheus/Grafana/Loki를 대체하지 않는다).

## dasomel 확인이 필요한 항목

- 위 3개 persona가 맞는지 확인/수정 — 실제 사용자 조사가 아니라 UX 이슈 세트에서 역으로 추론한 것.
- 위 MVP 기능 우선순위가 실제 우선순위와 맞는지 확인, 아니면 재정렬.
- 이 문서가 검토되어 그대로 승인되거나 수정될 때까지 #2는 열린 채로 둔다.

영문 버전은 [product-requirements.md](product-requirements.md) 참고.

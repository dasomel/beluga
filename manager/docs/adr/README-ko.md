# 아키텍처 결정 기록 (ADR)

이슈 #4(기술스택/아키텍처 tracking)를 위한 인덱스. 정합성 확인: 아래 세 ADR은 ADR-0002·ADR-0003을
작성하며 서로 교차 검토했고 충돌은 발견되지 않았다 — ADR-0002의 npm workspace/TypeScript 결정은
ADR-0001의 프론트엔드 선택을 전제로 하고, ADR-0003의 컴포넌트 구성 전체가 ADR-0001의 React 선택을
전제로 한다.

| ADR | 제목 | 상태 | 결정일 |
|---|---|---|---|
| [0001](0001-frontend-technology-ko.md) | 프론트엔드 기술 선정 | 승인됨 — React + TypeScript + Vite, 정적 SPA | 2026-09-21 (2026-09-19 배포된 구현으로부터 소급 기록) |
| [0002](0002-backend-api-technology-ko.md) | 백엔드/API 기술 선정 | 승인됨 — TypeScript/Node.js, npm workspace, Hono + `@hono/zod-openapi` | 2026-09-21 |
| [0003](0003-ui-design-system-ko.md) | UI 디자인 시스템 & 컴포넌트 전략 | 승인됨 — shadcn/ui(Radix+Tailwind, vendored), WCAG 2.2 AA 목표 | 2026-09-21 |

## 이 세 개로 아직 닫히지 않는 것

이슈 #4 자체의 완료 기준은 "세부 ADR 간 충돌이 없고, 최종 Architecture Diagram 및 ADR index가
문서화되는 것"이다 — 인덱스는 이 파일이고 충돌도 없지만, 이슈 #4는 아직 해결되지 않은 4개의
형제 tracking 이슈도 함께 나열한다: #23(Service Integration Adapter Model), #24(Observability
Integration), #25(Deployment & GitOps Integration), #29(API Contract & Domain Model). 이들은 아직
열려 있다.

## 새 ADR 추가하기

0001-0003에서 이미 확립된 형식(Context, Decision Drivers, Considered Options, Decision Outcome,
Consequences, Open Questions)을 따르고, 이 저장소의 이중언어 문서 규약에 따라 영문과 `-ko` 파일을
함께 추가한다. 이 인덱스와 그 한국어 짝 파일에서 새 파일을 링크한다.

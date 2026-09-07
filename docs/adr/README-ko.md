# 아키텍처 결정 기록 (ADR)

[English](README.md) | 한국어

이 디렉터리는
[OpenForge Decision Management Standard](https://github.com/dasomel/openforge/blob/main/docs/decision-management.md)에
따라 Beluga 프로젝트의 지속적이고 범부서적인 아키텍처 결정을 기록한다. 일상적인
운영 결함과 근본 원인은 여기가 아니라 [docs/mistakes-log.md](../mistakes-log.md)에
기록한다 — ADR은 "왜 이 지속적인 선택을 했는가"를 기록하고, 실수 로그는 "왜
깨졌고 어떻게 고쳤는가"를 기록한다.

## 인덱스

| ADR | 제목 | 상태 | 날짜 |
|---|---|---|---|
| [ADR-0001](0001-vagrant-k3s-gitops-platform-architecture-ko.md) | Vagrant + k3s + ArgoCD GitOps 플랫폼 아키텍처 | Accepted | 2026-08-09 |
| [ADR-0002](0002-bootstrap-time-random-credential-generation-ko.md) | 부트스트랩 시점 랜덤 자격증명 생성 | Accepted | 2026-08-10 |

## 신규 ADR 추가 기준

표준에 따라, 변경이 아키텍처나 레이어 경계에 영향을 주거나, 신뢰/접근/시크릿/릴리스
경계를 바꾸거나, 의미 있는 트레이드오프가 있는 대안들 중 하나를 의도적으로
선택하는 경우 신규 ADR을 검토한다. 이미 승인된 결정으로 전부 결정되는 통상적인
구현 작업은 신규 ADR이 필요 없다.

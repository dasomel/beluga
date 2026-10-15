# Beluga Manager 기여 가이드

Beluga Manager에 기여해 주셔서 감사합니다.

Beluga Manager는 Beluga Data Platform을 위한 통합 Control Plane을 구축하는 오픈소스 프로젝트입니다.

## 개발 원칙

- 사용자에게 보이는 문서는 English와 Korean을 별도 파일로 관리합니다.
- English는 `<name>.md`, Korean은 `<name>-ko.md` 규칙을 사용합니다.
- 전문 OSS UI를 재구현하기보다 authoritative OSS API를 활용합니다.
- Beluga Domain API는 특정 언어에 종속되지 않도록 합니다.
- Topic, Table, Job, Namespace 등의 실제 리소스 이름은 번역하지 않습니다.
- 변경은 작고 테스트 가능하게 유지합니다.
- 프로젝트 경계에 영향을 주는 아키텍처 결정은 ADR로 기록합니다.

## Pull Request

1. 문제와 해결 방법을 설명합니다.
2. 관련 Issue를 연결합니다.
3. 테스트를 포함하거나 테스트가 불필요한 이유를 설명합니다.
4. 사용자에게 보이는 변경이나 아키텍처 변경은 문서를 함께 수정합니다.
5. English와 Korean 문서의 의미와 구조를 일치시킵니다.

English version: [CONTRIBUTING.md](CONTRIBUTING.md)

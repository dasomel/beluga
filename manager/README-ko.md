English | [한국어](README-ko.md)

# Beluga Manager

> Beluga Data Platform을 위한 통합 Control Plane

Beluga Manager는 Beluga Data Platform의 통합 진입점입니다. 개별 오픈소스 구성요소의 API를 통합하여 하나의 Domain Model, Control Plane, 사용자 경험을 제공합니다.

Beluga Manager는 **OSS 모음 Portal이 아닙니다.** Kafka, Flink, Iceberg, Trino, Airflow 등 각 구성요소가 자신의 리소스에 대한 authoritative source로 남고, Manager는 각 API를 연계하여 Pipeline, Data Asset, Service, Operations와 같은 Beluga 플랫폼 개념으로 통합합니다.

## 왜 Beluga Manager인가?

Kafka, Flink, Iceberg, Trino, Airflow 같은 OSS는 각각 훌륭한 기능과 전문 UI/API를 제공합니다. 문제는 하나의 Data Platform을 실제로 운영할 때 발생하는 **서비스 사이의 연결과 운영 맥락**입니다.

Beluga Manager는 다음 질문에 하나의 화면과 Domain으로 답하는 것을 목표로 합니다.

- 어떤 Pipeline이 어떤 Kafka Topic, Flink Job, Iceberg Table과 연결되어 있는가?
- 특정 Data Asset은 어느 Catalog/Schema/Table에 있고 어떤 Query Context를 가지는가?
- 플랫폼을 구성하는 서비스가 정상인지, 어떤 Capability를 제공하는가?
- 하나의 장애가 어떤 Service/Job/Data Asset에 영향을 주는가?

즉, 개별 OSS UI를 다시 만드는 것이 아니라 **OSS API를 조합해 하나의 Data Platform 경험을 제공**합니다.

## 아키텍처

```text
                        Beluga Manager
                              │
                  Unified Domain / API
                              │
       ┌──────────────┬───────┼────────┬──────────────┐
       ↓              ↓       ↓        ↓              ↓
    Kafka           Flink   Iceberg   Trino         Airflow
      API             API      API      API            API
       └──────────────┴───────┴────────┴──────────────┘
                              │
                    Beluga Data Platform
```

Manager는 각 OSS의 UI나 데이터를 무분별하게 복제하지 않고 authoritative API를 조합합니다. 필요한 관계 정보는 Discovery/Correlation 계층에서 연결하고, 성능을 위한 Cache와 최소한의 Correlation Index만 사용합니다.

## 핵심 Domain

### Pipeline

서로 다른 서비스의 리소스를 하나의 데이터 흐름으로 표현합니다.

```text
Source / CDC
    ↓
Kafka Topic
    ↓
Flink Job
    ↓
Iceberg Table
    ↓
Trino / Query
```

Pipeline Domain은 각 OSS의 관계를 correlation하여 하나의 운영 단위로 제공합니다.

### Data Asset

Iceberg와 Trino의 metadata를 기반으로 Catalog, Schema, Table, Column, Partition, Location, Query Context 등을 하나의 Data Asset으로 제공합니다.

### Service

Kafka, Flink, Iceberg, Trino, Airflow 등의 서비스를 단순 설치 목록이 아니라 Streaming, Processing, Lakehouse, Query, Orchestration 등의 Platform Capability로 표현합니다.

### Operations

Resource, Event, Health, Log, Dependency 등의 운영 정보를 통합하여 문제 발생 시 여러 OSS UI를 순차적으로 확인하지 않고 원인과 영향을 탐색할 수 있도록 합니다.

## 통합 원칙

- 각 OSS의 authoritative API를 사용합니다.
- OSS API 모델을 그대로 Frontend에 노출하지 않고 Beluga Domain Model로 변환합니다.
- Resource 이름, identifier, topic, table, job, namespace 등 실제 값은 번역하지 않습니다.
- Backend API는 locale-neutral로 유지합니다.
- 추정된 correlation과 authoritative 관계를 구분합니다.
- OSS API 장애나 stale cache 상태를 명확히 표현합니다.
- 특정 OSS 버전에 과도하게 결합되지 않도록 Adapter와 Capability 모델을 사용합니다.
- 전문 기능이 필요한 경우 원래 OSS UI/API로 context를 유지한 채 이동할 수 있습니다.

## 다국어

Beluga Manager는 MVP부터 다국어를 기본 지원합니다.

- `en-US` — English
- `ko-KR` — 한국어
- 브라우저 언어 자동 감지
- 사용자가 직접 언어 선택
- 선택 언어 유지
- locale-neutral API
- 날짜/시간/숫자 locale 처리

## 초기 MVP

첫 번째 Vertical Slice는 다음 경로입니다.

```text
Kafka → Flink → Iceberg → Trino
```

초기 구현 범위:

- Unified Service API
- Service discovery
- Cross-service correlation
- Pipeline Domain API
- Pipeline topology view
- Service health/status
- stale/degraded 상태 표현
- 실패 resource에 대한 event/log drill-down

초기 단계에서는 광범위한 mutation 기능을 넣지 않고 **read-only 통합 경험을 먼저 검증**합니다.

## 현재 상태

🚧 **초기 개발 단계**

현재 저장소는 프로젝트 Foundation과 Architecture를 구성하고 있으며, API Contract → Unified Service API → Vertical Slice 순서로 구현을 진행합니다.

## 문서

- [English README](README.md)
- [Architecture / 아키텍처](docs/architecture-ko.md)
- [Development Guide / 개발 가이드](docs/development-ko.md)
- [Contributing / 기여 가이드](CONTRIBUTING-ko.md)
- [Security / 보안 정책](SECURITY-ko.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).

# ADR-0002: Backend / API Technology Selection

- **상태**: 제안됨 — 결정 대기
- **날짜**: 2026-09-18
- **이슈**: [#27 \[EVALUATION\]\[ADR\] Backend/API Technology Selection](https://github.com/dasomel/beluga-manager/issues/27)
- **상위 에픽**: #1
- **관련 문서**: [ADR-0001](0001-frontend-technology-ko.md), [ADR-0003](0003-ui-design-system-ko.md)
- **결정권자**: dasomel

## 배경

Beluga Domain API는 아직 존재하지 않는다. 현재 이 저장소에 존재하는 것은 **정책 컴파일러**뿐이다:
TypeScript (7.0.2, Node ≥22, ESM), `src/schema.ts`의 Zod 4.5.4 스키마, Keycloak realm 설정과
Trino OPA Rego, PostgreSQL DDL을 생성하는 `src/compiler/`의 컴파일 타깃, `src/adapters/types.ts`의
어댑터 타입 경계, 그리고 Vitest 5 테스트. 이것이 실행 가능한 코드의 전부다.

구축해야 할 API는 이 저장소가 아니라 이슈 기록에 의해 정의된다:

- **#34 Unified Domain API** — Kafka, Flink, Iceberg, Trino, Airflow API를 집계하여 Beluga 고유의
  Pipeline, Data, Service 도메인으로 만든다. **단순한 API 프록시가 아님**을 명시적으로 밝히고 있으며,
  업스트림 API 버전 차이는 Integration Adapter 계층 내부에 격리되어야 한다.
- **#42 Unified Service API** — Kafka, Flink, Iceberg, Trino, Airflow, Kubernetes 그리고 관측성
  백엔드 전반에 걸친 하나의 공통 서비스 모델(식별자/타입, 버전, 헬스, 엔드포인트, 능력, 의존성 요약,
  가용/저하 상태). 성공 기준: Overview 및 Services 화면이 각 OSS API를 직접 호출하는 대신 이 API를
  소비한다.
- **#43 API contract** — `GET /api/v1/services`, `/services/{id}`, `/pipelines`, `/pipelines/{id}`,
  `/data-assets`, `/health`, `/events`에 대한 OpenAPI-first 계약으로, 버전 관리, 일관된
  error/degraded/stale 응답, 페이지네이션과 필터링, 상관관계 상태의 명시적 표현을 포함한다. 완료 기준:
  프런트엔드가 Beluga API만으로 MVP를 구축할 수 있어야 한다.
- **#29 도메인 모델** — Platform, Service, Resource, DataCatalog, Pipeline, Job, Event, Health,
  User/Role; 공통 상태/헬스 모델; 서비스별 메타데이터 확장 모델. 원칙: API는 Beluga의 도메인을
  표현해야 하며 **UI 주도로 설계되어서는 안 된다.**
- **#22 경계** — 프런트엔드는 서비스별 자격 증명이나 API를 직접 다루지 않는다. 백엔드가 유일한 통합
  지점이며 프런트엔드에는 최소한의 데이터만 전달한다.
- **#41 MVP** — 최소한의 Kafka/Flink/Iceberg/Trino 어댑터, 서비스 디스커버리, 크로스 서비스
  상관관계, Pipeline Domain API, 토폴로지 UI. **읽기 전용**이며 변경(mutation)은 범위 밖이다.
- **#19/#18**은 Kubernetes 리소스, 이벤트, 워크로드 데이터(namespace, workload, pod, service, PVC,
  CPU/메모리)와 Loki 로그 연결을 필요로 한다.
- **#20/#21**은 역할/권한 조회, 최소 권한, 자격 증명 노출 금지, 그리고 — 향후 변경 작업이 도입될 때 —
  액션별 RBAC, 확인, dry-run, 감사 로그를 요구한다.

이미 형제 프로젝트인 `beluga` 플랫폼에서 확정되어 이곳에도 구속력을 갖는 환경적 제약:

- **Keycloak 26.7.1이 플랫폼의 단일 identity 및 role 소스**이며(결정 D13), `sso.local.beluga.internal`에서
  접근 가능하다. Trino의 OAuth2 issuer는 이미 이 호스트다.
- **OPA 1.19.0이 중앙 정책 엔진**이며(D14), 이 저장소의 컴파일러가 이미 Trino Rego와 Keycloak
  group/role 매퍼를 생성한다. 따라서 인가 모델은 *이미 선택되어 있으며*, API는 이를 새로 고안하는 것이
  아니라 소비하는 것이다.
- **APISIX 3.17.0이 게이트웨이**이며(D11), 모든 접근은 `*.local.beluga.internal` 아래의 통합 HTTPS
  443을 통해 이루어진다.
- **`selfHeal: true`를 적용한 ArgoCD 3.5.0 GitOps**가 워크로드를 배포한다. 새 서비스는 곧 새 이미지를
  의미하며, **arm64와 amd64** 양쪽으로 빌드되어야 하고(VERSIONS.md는 arm64 가용성을 게이팅 조건으로
  다룬다) air-gapped 레지스트리로 미러링되어야 한다.
- **Air-gapped 친화성**은 상시 아키텍처 원칙이다(`docs/architecture.md`, 원칙 7).

### MVP 백엔드 최소 범위

이슈 #27은 기술을 선택하기 전에 최소 백엔드 범위를 정의할 것을 요구한다. #41/#42/#43에서 도출된
MVP 백엔드는 다음을 만족해야 한다:

1. OIDC를 종료한다 — Keycloak이 발급한 JWT를 검증하고, role/group을 추출하며, 읽기 접근을 강제한다.
2. 모든 업스트림 자격 증명을 서버 측에 보관한다; 브라우저는 이를 절대 보지 못한다.
3. Kafka, Flink, Iceberg(Lakekeeper REST), Trino에 대한 읽기 전용 어댑터와, 리소스 및 이벤트를 위한
   Kubernetes 어댑터를 실행한다.
4. 서비스 디스커버리와 크로스 서비스 상관관계를 수행하며, provenance와 confidence를 보존한다
   (`docs/architecture.md`, 원칙 6: 불확실한 관계를 사실인 것처럼 제시해서는 안 된다).
5. OpenAPI 계약에 따라 일곱 개의 `/api/v1/*` 엔드포인트를 제공하며, 일관된 degraded/stale/partial
   응답 형태를 포함한다.
6. 업스트림 응답을 짧게 캐시하고, 상관관계 인덱스를 유지한다 — 명시적으로 두 번째 메타데이터 저장소는
   **아니다**(README: "데이터 플랫폼 메타데이터 저장소의 두 번째 사본을 두지 않는다").
7. 클러스터를 위한 구조화된 로그와 health/readiness 엔드포인트를 출력한다.

그 외 모든 것 — 변경(mutation)(#21), 전체 데이터 카탈로그(#15), lineage, 감사 영속화 — 는 이후 과제다.

## 결정 요인

1. **기존 코드와의 계약 응집성** — Zod 스키마는 이미 이 저장소의 검증된 형태를 인코딩하고 있다; 같은
   언어의 API라면 이를 런타임 검증, 정적 타입, OpenAPI 생성을 위한 단일 원천으로 공유할 수 있다.
2. **I/O 동시성 프로파일** — 워크로드는 다수의 느린 HTTP 업스트림에 대한 팬아웃과 결과 병합이다.
   거의 전적으로 I/O-bound이며, 원시 CPU 처리량은 거의 무관하다.
3. **Kubernetes API 클라이언트 품질** — #18/#19는 실제 Kubernetes 읽기를 필요로 한다.
4. **Auth/authz 통합** — 기존 Keycloak realm에 대한 OIDC 검증과, 이 저장소가 이미 컴파일하고 있는
   OPA/Rego 모델과의 정합성.
5. **OpenAPI-first 도구** — #43은 계약을 부산물이 아니라 산출물로 만든다.
6. **운영 부담** — 이미지 크기, 메모리, 시작 시간, arm64+amd64 가용성, CVE 노출 면.
7. **소규모 팀에서의 유지보수성** — 스택 전체에서 언어 하나를 쓰느냐 둘을 쓰느냐.
8. **관측성 통합** — 구조화된 로그, 기존 Prometheus 스택을 위한 메트릭, 선택적으로 OpenTelemetry
   트레이스.

## 검토한 선택지

### 옵션 A — TypeScript / Node.js, 이 저장소의 런타임을 확장(Fastify, Hono 또는 Express)

기존 컴파일러 옆에 같은 언어와 툴체인으로 HTTP 계층을 추가한다.

**장점**

- **타입과 스키마 재사용이 결정적 이점이다.** `src/schema.ts`는 이미 Zod 스키마를 정의하고 있다.
  같은 Zod 정의가 요청/응답 검증을 수행하고, #43이 요구하는 OpenAPI 문서를 생성하며, 프런트엔드가
  직접 import하는 TypeScript 타입을 내보낼 수 있다. 다른 어떤 런타임에서도 이 계약은 두 번째 언어로
  다시 기술되어야 하고, 규율과 테스트로만 동기화를 유지할 수 있다.
- `src/adapters/types.ts`의 어댑터 경계는 이미 #34가 설명하는 integration-adapter 계층을 예상하고
  있다; 새로 발명할 필요 없이 기존 형태를 확장할 수 있다.
- 워크로드는 팬아웃 I/O 집계이며, Node의 이벤트 루프가 이를 잘 처리한다; 어댑터별 타임아웃을 둔
  N개 업스트림에 대한 `Promise.allSettled`는 #42와 #43이 요구하는 partial/degraded 시맨틱스에
  자연스럽게 들어맞는다.
- 단일 언어, 단일 lint/format/test 툴체인(이미 갖춰진 Vitest 5), 단일 의존성 감사 대상, 단일 채용
  프로필 — 소규모 팀에게는 실질적인 이점이다.
- 성숙한 OIDC/JWT 검증(`jose`), 공식 Kubernetes 클라이언트(`@kubernetes/client-node`), 공식
  Trino 클라이언트, Kafka 클라이언트(KafkaJS, `node-rdkafka`)가 모두 사용 가능하며 라이선스 제약이
  느슨하다; arm64와 amd64용 공식 Node 이미지가 존재한다.
- ADR-0001이 TypeScript 프런트엔드를 선택한다면, 전체 스택이 하나의 언어를 공유하게 된다.

**프레임워크 하위 선택지** — Fastify(스키마 우선, 뛰어난 JSON-schema/OpenAPI 지원, 플러그인 캡슐화,
빠르고 성숙하며 큰 플러그인 생태계 — 계약 우선 API에 가장 안전한 선택); Hono(매우 작고 현대적이며
TypeScript 추론이 뛰어나고 런타임 이식성이 좋으나 엔터프라이즈 관심사를 위한 생태계는 더 작음);
Express(널리 쓰이고 친숙하지만 스키마 우선성이 가장 약하고 TypeScript 지원이 가장 얕으며 일급
OpenAPI 경로가 없음).

**단점**

- Kubernetes 클라이언트는 훌륭하지만 `client-go`는 아니다; 고급 informer/watch 패턴에서는 검증
  이력이 상대적으로 얕다. MVP의 읽기 전용 리스팅에는 충분하다.
- Node의 메모리 사용량과 CVE 주기는 컴파일된 바이너리보다 크다.
- 장수명 Kafka/Flink 연결과 무거운 JSON 변환은 이벤트 루프 정체를 피하기 위한 주의가 필요하지만,
  API를 데이터 플레인 컴포넌트가 아닌 집계기로 유지함으로써 완화된다.
- 현재 CLI를 만들어내는 저장소에 서버를 추가하는 것은 저장소의 성격을 바꾼다; 컴파일러가 독립적으로
  사용 가능하게 남도록 명확한 내부 경계가 필요하다.

### 옵션 B — Go

**장점**

- **`client-go`가 기준이 되는 Kubernetes 클라이언트다** — Go를 지지하는 가장 강력한 단일 기술적
  근거이며, #18/#19와 직접 관련된다. Informer, watch, 타입이 지정된 객체가 최고 수준이다.
- 단일 정적 바이너리: 작은 이미지(distroless/scratch), 빠른 시작, 낮은 메모리, 작은 CVE 노출 면,
  사소한 수준의 arm64/amd64 교차 컴파일 — 어떤 선택지보다도 뛰어난 운영 프로파일이며, air-gapped
  미러링에도 가장 우호적이다.
- 고루틴은 팬아웃 집계에 매우 자연스럽게 어울리며, context/취소 시맨틱스도 성숙해 있다.
- Kubernetes 생태계의 공용어다; OPA, ArgoCD, Trino 게이트웨이와 대부분의 클러스터 도구가 Go로
  작성되어 있어 관용구와 라이브러리가 잘 맞는다.

**단점**

- **계약 응집성을 깨뜨린다.** 도메인 모델이 두 번 존재하게 된다: 컴파일러와 프런트엔드를 위한
  TypeScript의 Zod, API를 위한 Go 구조체. 양측에서 생성기를 두어 OpenAPI를 공유 원천으로 삼을 수는
  있지만, 이는 실질적으로 지속적인 관리가 필요한 장치이며 정확히 #29/#43이 피하고자 하는 중복이다.
- 소규모 팀에서 두 언어: 두 개의 툴체인, 두 개의 의존성 감사, 두 개의 리뷰 역량이 필요하다.
- 이 서비스를 지배하는 JSON 가공 및 상관관계 로직에 있어 더 장황하다.
- Go의 이점은 Kubernetes 접근에 집중되어 있는데 — 여러 어댑터 중 하나일 뿐 — 그 비용은 전체
  코드베이스에 걸쳐 지불된다.

### 옵션 C — Python (FastAPI)

**장점**

- 뛰어난 OpenAPI 지원: FastAPI는 Pydantic 모델로부터 계약을 생성하며, 이는 옵션 A의 Zod 기반
  접근과 매우 유사하다.
- Pydantic v2는 강력한 런타임 검증과 좋은 타이핑 편의성을 제공한다.
- 공식 Kubernetes Python 클라이언트는 탄탄하며, Trino/Airflow는 일급 Python 클라이언트를
  보유한다 — Airflow 자체가 Python이므로, 생태계 정합성은 어떤 선택지보다도 뛰어나다.
- 작성 속도가 빠르며 매우 큰 인재 풀을 갖고 있다.
- 이 저장소는 이미 `scripts/verify.py`와 `make` 타깃을 위해 Python을 사용하고 있으므로, Python이
  프로젝트에 낯설지 않다.

**단점**

- Go와 동일한 계약 중복 문제를 안는다: Pydantic 모델이 Zod가 이미 표현하는 것을 다시 기술한다.
- ASGI 동시성은 작동 가능하지만 런타임은 Node나 Go보다 무겁고, 이미지가 더 크며, air-gapped
  환경에서의 의존성/패키징 관리가 세 언어 중 가장 고통스럽다.
- 타이핑이 선택적이며 점진적으로만 강제된다; 대규모 리팩터링은 TypeScript나 Go보다 안전성이 떨어진다.
- Python을 빌드 툴링 런타임이 아닌 *제품* 런타임으로 도입하게 된다 — 현재의 `scripts/` 사용보다
  훨씬 큰 투입이다.

### 옵션 D — 백엔드 없는 SPA가 APISIX를 통해 업스트림 API를 직접 호출

프런트엔드가 Kafka, Flink, Trino, Lakekeeper, Kubernetes API를 직접 호출하고, APISIX가 라우팅과
OIDC를 처리한다.

**장점**

- 새로 만들거나 배포하거나 운영할 서비스가 없다; 첫 화면에 도달하는 가장 빠른 경로다.
- APISIX는 실제로 OIDC 종료, 라우팅, 속도 제한, CORS를 수행할 수 있다.

**단점 — 이 선택지는 이미 내려진 결정들에 의해 사실상 배제된다**

- **#22를 직접 위반한다**: 프런트엔드가 서비스별 자격 증명과 API를 다루게 되며, 이는 해당 이슈가
  금지하는 것이다. Kafka나 Kubernetes API용 토큰을 브라우저가 보유하는 것 역시 #20의 최소 권한과
  자격 증명 노출 금지 원칙에 대한 심각한 보안 퇴행이다.
- **제품을 구현할 수 없다.** #34는 Kafka, Flink, Iceberg, Trino를 Pipeline 객체로 상관시킬 것을
  요구하며, 이것이 프록시가 아님을 명시하고 있다. 게이트웨이는 라우팅만 할 뿐, 상관관계를 만들거나
  버전 차이를 조정하거나 provenance와 confidence를 계산하지 않는다. 이 작업을 브라우저에서
  수행한다면, #34가 어댑터 안에 격리하고자 하는 로직을 가장 신뢰할 수 없고 가장 테스트하기 어려운
  계층으로 밀어넣는 셈이 된다.
- **README와 AGENTS.md에 위배된다**: "프런트엔드는 Kafka, Flink, Iceberg, Trino, Airflow API를
  직접 호출하지 않고도 MVP를 구현할 수 있어야 한다", "UI에서 domain API를 우회하여 업스트림 OSS를
  직접 호출하지 않는다."
- 모든 업스트림 API 버전 차이가 UI로 새어나가게 되며, 이는 #34가 명시적으로 금지하는 바다.

완결성을 위해, 그리고 이 질문을 매듭짓기 위해 기록되었을 뿐 — 실행 가능한 후보가 아니다.

### 옵션 E — Java / Kotlin (Spring Boot 또는 Quarkus)

**장점**

- JVM은 이 데이터 플랫폼의 네이티브 생태계다: Kafka, Flink, Trino, Iceberg 모두 일급 Java
  클라이언트를 게시하며, 대개 어떤 언어보다도 가장 완전하고 최신 상태를 유지한다.
- 매우 성숙한 엔터프라이즈 auth, OpenAPI, 관측성 통합.
- 네이티브 컴파일을 활용한 Quarkus는 작은 풋프린트에 도달할 수 있다.

**단점**

- JVM 경로에서 가장 무거운 운영 부담(메모리, 시작 시간, 이미지 크기); 네이티브 컴파일이 이를
  줄여주지만 빌드 복잡성을 더한다.
- 기존 TypeScript 코드베이스와 가장 멀다; 계약 중복이 최대치다.
- 어떤 선택지보다도 가장 큰 팀 스킬 가정을 요구하며, 저장소 내에는 이를 뒷받침할 근거가 없다.

플랫폼의 업스트림 클라이언트가 Java 우선이기 때문에 기재되었을 뿐, JVM 전문성이 존재한다는 신호가
없는 한 더 발전시키지 않는다.

## 결정 결과

**승인됨: Option A — TypeScript/Node.js, 기존 정책 컴파일러·프론트엔드와 같은 npm workspace, HTTP
프레임워크는 Hono + `@hono/zod-openapi`(아래 멀티모델 리뷰에 따라 원래의 Fastify 권고에서 변경).**

2026-09-21 dasomel이 아래 6개 미해결 질문을 해결하며 결정:

1. **저장소 구조: 단일 저장소, npm workspace.** `packages/policy-compiler`, `packages/domain-api`,
   `packages/shared-schema`, `packages/web`(또는 동등 구조) — ADR-0001의 프론트엔드가 이미 여기 있는
   것과 맞물리고, `src/schema.ts` 스타일 Zod 스키마를 다시 쓰지 않고 공유할 수 있다.
2. **컴파일러 ↔ API 관계: 분리 유지.** 컴파일러는 GitOps 산출물을 내보내는 build-time CLI로 남고,
   보안/정책 화면은 컴파일러 산출물을 런타임 진실 원천으로 읽는 대신 live Keycloak/OPA를 조회한다.
3. **인가: OPA에 위임.** API는 인증·입력 검증·fail-closed를 담당하고, 상세 인가는 하드코딩된 두
   번째 정책 어휘를 만드는 대신 플랫폼의 기존 OPA 인스턴스를 조회한다. (멀티모델 리뷰의 남은
   항목: OPA 자체가 응답하지 않을 때 API 자신의 fail-closed 동작을 정의할 것.)
4. **Kubernetes-네이티브 충실도: 아홉 관점 중 하나이며 제품의 무게중심이 아니다.**
   `@kubernetes/client-node`가 MVP 리소스/이벤트 조회에 충분하며, 이를 위해 Go/`client-go`를
   채택하지 않는다. 향후 고빈도 watch나 엄격한 캐시 정합성이 실제 요구사항이 될 때만 재검토한다.
5. **데이터베이스: 없음 — 재구축 가능한 ephemeral 캐시만.** 상관관계 상태는 요청 시 upstream API에서
   유도하거나 짧게 캐시하며, Beluga 소유의 durable 저장소로 영속화하지 않는다. 새 데이터베이스
   의존성 없음; CNPG Postgres를 이 서비스 범위로 끌어들이지 않는다. "두 번째 메타데이터 저장소
   금지"라는 기존 원칙과 일치한다.
6. **Push vs poll: MVP는 poll.** 읽기 전용 콘솔 및 기존 SPA의 polling/caching 관용구(ADR-0001의
   TanStack Query)와 일치한다. 이후 이벤트/freshness UX가 요구하면 재검토한다.

Backend/API 기술 선택은 `AGENTS.md`에 따른 설계 변경이며, 위 내용이 이를 해결한다. 그 결과로 나오는
공개 API 계약(#43)은 구현되면서 별도로 검토할 그 자체의 설계 변경으로 남는다.

---

> ### 🏛 아키텍트 권고 *(참고용 권고 — 결정이 아님)*
>
> **옵션 A: 이 저장소 내에서 npm workspace 형태로, Fastify와 함께 TypeScript/Node에 머무른다.**
>
> **가장 결정적인 이유:** 여기서 제품은 곧 도메인 계약이며(#29, #43), TypeScript는 그 계약이
> 정확히 한 번만 존재하는 유일한 선택지다. `src/`에 이미 있는 Zod 스키마는 런타임에서 요청을
> 검증하는 동시에 #43이 요구하는 OpenAPI 문서를 생성하고 프런트엔드가 소비하는 타입을 내보낼 수
> 있다 — 따라서 API, 컴파일러, UI가 소리 없이 어긋날 수 없다. 다른 모든 선택지는 도메인 모델을
> 두 언어로 존재하게 만들어, "계약이 올바르다"는 명제를 컴파일 타임 속성에서 테스트와 규율의
> 문제로 바꿔버린다.
>
> **보조 근거**
>
> - 워크로드는 연산이 아니라 partial-failure 시맨틱스를 가진 팬아웃 I/O다. Node는 좋은 선택이며,
>   이 언어의 약점(CPU-bound 작업, 장수명 상태 유지 연결)은 읽기 전용 집계기의 critical path에
>   놓여 있지 않다.
> - `src/adapters/types.ts`는 이미 #34가 설명하는 어댑터 경계를 스케치하고 있다.
> - Vitest 5가 이미 테스트 러너다; API는 기존 테스트 관용구를 그대로 물려받는다.
> - 컴파일러, API, 그리고(ADR-0001이 TypeScript로 간다면) 프런트엔드 전체에 걸쳐 하나의 언어를
>   쓰는 것은 이 규모의 팀에게 실질적인 이점이다.
>
> **Hono와 Express 대신 Fastify를 택한 이유:** Fastify의 스키마 우선 설계는 OpenAPI-first 계약에
> 직접적으로 대응하고, 플러그인 캡슐화는 어댑터별 격리를 자연스럽게 제공하며, 이 계층이 마땅히
> 그래야 하듯 "흥미롭지 않을 만큼" 성숙해 있다. 생태계보다 최소주의를 중시한다면 Hono가 합리적인
> 대안이다; Express는 #43이 가장 많은 지원을 필요로 하는 지점에서 가장 약한 스키마/OpenAPI 지원을
> 제공하므로 배제해야 한다.
>
> **솔직한 반론:** Go의 `client-go`는 어떤 Node Kubernetes 클라이언트보다도 실제로 더 우수하며,
> #18/#19는 Kubernetes 읽기에 의존한다. 그럼에도 TypeScript를 권고하는 이유는 그 이점이 어댑터
> 하나에 국한되어 있는 반면 계약 중복 비용은 모든 곳에서 지불되기 때문이다 — 하지만 만약
> Kubernetes 네이티브 동작(informer, watch, 고충실도 리소스 모델링)이 아홉 개의 화면 중 하나가
> 아니라 제품의 무게중심으로 드러난다면, Go가 더 나은 답이 되며 이 ADR은 그 증거를 바탕으로
> 재검토되어야 한다.
>
> **BFF 질문에 대해(#34):** 이를 **BFF가 아니라 domain API**로 취급한다. #29는 API가 Beluga의
> 도메인을 표현해야 하며 UI 주도로 설계되어서는 안 된다고 명시하고, #34는 이것이 프록시가 아니라고
> 명시한다. 진정한 BFF는 화면에 의해 형태가 결정되며 화면별 엔드포인트로 표류하는 경향이 있다.
> 안정적인 도메인 리소스(`/services`, `/pipelines`, `/data-assets`, `/events`)를 구축하고, 특정
> 화면이 비용이 큰 복합 조회를 필요로 하게 되면 필드 선택이나 `?expand=`를 가진 명시적이고 이름
> 붙은 집계 리소스를 추가한다 — `/api/ui/overview-page` 같은 엔드포인트가 아니라. 이는 명시적인
> 결정을 필요로 하는 실질적인 긴장 관계다.
>
> **인증에 대해:** 기존 Keycloak realm을 소비하며, 두 번째 identity 시스템을 만들지 않는다. API는
> Keycloak이 발급한 JWT를 검증하고(`sso.local.beluga.internal`에서 얻은 JWKS로 issuer, audience,
> 만료, 서명을 확인), realm/client role과 group을 Beluga 권한으로 매핑하며, 모든 업스트림 자격
> 증명을 서버 측에 보관한다. 가능하다면 새로운 병렬 어휘를 만들기보다 이 저장소의 컴파일러가 이미
> 생성하는 role 이름을 재사용한다 — 루트 워크스페이스 가이드는 role 이름이 LDAP 그룹명과
> 단일 원천으로서 일치해야 한다고 요구한다. OPA 1.19.0이 이미 플랫폼의 중앙 정책 엔진이고 이
> 저장소가 이미 Trino를 위한 Rego를 컴파일하고 있음을 감안하면, API 자체의 인가가 하드코딩된
> 검사를 두는 대신 OPA를 조회해야 하는지 평가한다; 그렇게 하면 Trino와 Manager에 걸쳐 하나의
> 정책 소스를 유지할 수 있다. 결론이 아니라 열린 질문으로 표시한다.

---

## 멀티모델 리뷰 (2026-09-21)

Codex(비평)와 Gemini(리서치)가 이 ADR을 검토했다. 결정 결과(여전히 dasomel의 몫)는 바꾸지 않고,
위 분석을 수정·보강하는 발견만 기록한다:

**"TypeScript만이 계약을 한 번만 둔다"는 표현은 과장됐다.** `src/schema.ts`의 Zod 스키마는 아직
정책 컴파일러 모델이지 Domain API 모델이 아니며, 향후 API와의 공유가 자동으로 보장되지 않는다 —
저장소가 분리되면 더더욱 아니다. OpenAPI를 정본으로 두는 방식은 Go나 Python에서도 가능하다.
TypeScript를 선호할 실제 근거는 "기술적으로 유일한 선택"이 아니라 **현재 코드베이스·팀과의
마찰이 가장 낮다**는 것이다. Fastify를 Hono보다 우선한 결정도 재검토할 만하다 — Fastify는
JSON Schema 기반이라 Zod를 쓰려면 브릿지(`fastify-type-provider-zod`)가 필요한 반면, Hono +
`@hono/zod-openapi`는 이 저장소가 이미 쓰는 동일한 Zod 스키마에서 OpenAPI 문서와 라우트 타입을
동시에 추론한다 — "Zod가 유일한 계약"이라는 목표에는 이쪽이 더 잘 맞는다.

**Kafka 클라이언트 안내가 오래됐다.** KafkaJS는 2023년 2월 이후 릴리스가 없고 KIP-848을 지원하지
않는다 — 신규 프로젝트의 기본 권장 대상이 될 수 없다. `@confluentinc/kafka-javascript`(Confluent
공식 클라이언트, node-rdkafka 기반, KafkaJS API 호환으로 마이그레이션 용이)가 현재 활발히
유지보수되는 경로다. Confluent 래퍼를 원치 않으면 `node-rdkafka` 직접 사용도 여전히 유효하다.
(검증됨: KafkaJS 2023-02 이후 릴리스 없음, `@confluentinc/kafka-javascript` v1.10.0 활발히 배포 중
— [Confluent 블로그](https://www.confluent.io/blog/introducing-confluent-kafka-javascript/),
[npm](https://www.npmjs.com/package/@confluentinc/kafka-javascript).)

**`@kubernetes/client-node`는 공식 유지보수**되고 있고(Kubernetes SIG API Machinery)
`makeInformer`/`Watch`를 지원하지만, Go `client-go` 대비 실질적 격차가 있다: 네트워크 순단 후
증분 재동기화가 아닌 전체 재조회(re-list), 덜 성숙한 백오프/재연결 처리,
`SharedIndexInformer` 수준보다 약한 로컬 인덱싱. MVP의 읽기 전용 조회에는 충분하지만, 향후
고빈도 watch나 엄격한 캐시 정합성이 요구되면 실질적 제약이 된다.

**빠진 Decision Driver/옵션**: 업스트림 rate-limit/timeout/retry/circuit-breaker/backpressure 및
부분 실패 처리; 백그라운드 reconciliation/이벤트 수집을 요청 경로에서 분리(이 서비스는 단순
동기 HTTP fan-out이 아니라 캐시·상관관계 인덱스·stale/degraded 상태를 관리하는 작은
control-plane이다); freshness/consistency SLO와 캐시 무효화; OPA 자체가 응답하지 않을 때의
fail-closed 정책과 시크릿 로테이션; 장기 연결을 필요로 하는 Kafka 컨슈머의 운영 복잡도; 현재
고려되지 않은 **하이브리드 옵션**(TypeScript Domain API + 별도 Go Kubernetes adapter/worker);
그리고 동기 fan-out API인지 캐시 기반 비동기 aggregator인지 — ADR이 아직 이름 붙이지 않은 실제
아키텍처 분기점.

**6개 미해결 질문 중** 이미 저장소 사실에서 기본값이 나오는 것과, AI가 대신할 수 없는 dasomel의
판단이 진짜 필요한 것을 Codex가 구분했다:

| # | 질문 | 저장소 사실에서 나오는 기본값 | dasomel 필요 여부 |
|---|---|---|---|
| 1 | Monorepo vs 분리 저장소 | Monorepo workspace(TS/Zod/Vitest/React가 이미 다 있고 계약 공유 이익이 실재) | **필요** — 저장소 소유권, 배포 독립성, 팀 운영 방식은 저장소 사실만으로 결정 불가하며, 이것이 첫 커밋을 막고 있다 |
| 2 | 컴파일러 ↔ API 관계 | 분리 유지: 컴파일러는 build-time CLI로 남고, 보안/정책 화면은 live Keycloak/OPA를 조회하며 컴파일러 산출물은 provenance/preview로 취급 | 불필요 — 이미 사실에서 따라나옴 |
| 3 | OPA에 인가 위임? | 위임 — OPA가 이미 플랫폼의 정책 엔진이고 이 저장소가 이미 그것을 위해 Rego를 컴파일하므로, API는 인증/입력 경계/fail-closed를 담당하고 인가 세부는 OPA에 위임 | 불필요 — 이미 사실에서 따라나옴 |
| 4 | Kubernetes-네이티브 충실도가 얼마나 중요한가 | — | **필요** — K8s가 아홉 관점 중 하나인지 제품의 무게중심인지는 제품 의도이며, Go 재검토 여부에 실질적 영향 |
| 5 | API가 자체 데이터베이스가 필요한가 | 진짜 durable state가 필요하다면 Postgres를 index/mapping 전용으로만 사용 | **필요** — 상관관계 상태가 재구축 가능한 ephemeral 캐시인지 durable한 사용자 관리 매핑인지는 제품/내구성 판단 |
| 6 | Push vs poll | MVP는 poll(읽기 전용 콘솔, 기존 SPA의 polling/caching, 더 단순한 gateway와 부합) | 부분적 — 나중에 재검토가 필요해지면 허용 가능한 freshness와 이벤트 UX/SLO는 dasomel의 판단 |

---

## 결과 및 영향

**옵션 A가 선택될 경우:**

- 이 저장소는 다중 패키지 워크스페이스(예: `packages/policy-compiler`, `packages/domain-api`,
  `packages/shared-schema`, 그리고 가능하다면 `packages/web`)가 되거나, API가 별도 저장소로
  이전된다. **이는 미해결 상태이며** 첫 커밋을 막는다 — 미해결 질문 섹션 참고.
- 컨테이너 이미지, Deployment, Service, probe, 리소스 제한, ArgoCD application 항목이 GitOps
  저장소에 추가되며, arm64와 amd64로 빌드되어 air-gapped 사용을 위해 미러링된다.
- APISIX는 API 호스트 또는 경로 프리픽스를 위한 라우트를 얻으며, SPA의 토큰 처리와 합의된 CORS 및
  OIDC 태세를 갖춘다.
- 의존성 관리 정책이 필요하다: Node의 의존성 노출 면은 후보들 중 가장 크며,
  `docs/dependency-incident-response.md`가 이미 존재한다 — API는 이 정책 아래에 명시적으로
  편입되어야 한다.
- 어댑터 격리는 구조적으로 강제되어야 한다(업스트림당 하나의 모듈, 업스트림 타입이 도메인 계층으로
  넘어가지 않음). #34가 이 경계를 선호 사항이 아니라 요구 사항으로 만들기 때문이다.
- Degraded/stale/partial 시맨틱스는 첫 엔드포인트부터 응답 envelope에 설계되어 있어야 하며 나중에
  소급 적용되어서는 안 된다; #42와 #43 모두 이를 요구하며 나중에 추가하기는 매우 어렵다.

**모든 경우에 공통으로:**

- OpenAPI 문서는 `docs/` 아래에서 검토 대상 산출물이 되며, 저장소의 이중 언어 문서화 규칙이 이를
  수반하는 모든 산문에 적용된다.
- 상관관계 결과는 provenance와 confidence를 담아야 한다; 응답 스키마는 `docs/architecture.md`
  원칙 6과 AGENTS.md에 따라 "이 관계는 추론된 것"이라고 표현할 수 있어야 한다.
- MVP는 읽기 전용이다. 변경(mutation) 엔드포인트(#21)는 해당 이슈가 설명하는 액션별 RBAC, 확인,
  dry-run, 감사 모델 없이 추가되어서는 안 된다.
- 캐싱은 단명(short-lived)하며 명시적으로 시스템 기록의 두 번째 원천이 *아니다*.

## dasomel 확인이 필요한 미해결 질문

1. **모노레포인가, 별도 저장소인가?** ADR-0001과 공유되는, 우선순위가 가장 높은 미지수다:
   TypeScript의 타입 공유 논거 전체는 하나의 워크스페이스에서 가장 강력하며, 프런트엔드와 API,
   컴파일러가 게시된 패키지로 연결된 세 개의 저장소로 나뉠 경우 약화된다.
2. **정책 컴파일러는 API와 런타임상 어떤 관계를 갖는가?** 현재는 GitOps 산출물을 출력하는 빌드
   타임 CLI다. #20의 보안/정책 뷰는 그 산출물을 읽는가, 컴파일러를 호출하는가, 아니면
   Keycloak/OPA를 실시간으로 조회하는가? 이는 이들이 애당초 하나의 프로세스에 속해야 하는지를
   결정한다.
3. **API가 인가를 OPA에 위임해야 하는가?** OPA는 이미 플랫폼의 중앙 정책 엔진이며 이 저장소는
   이미 Trino를 위한 Rego를 컴파일하고 있다. 이를 재사용하면 정책 소스가 하나로 유지되지만,
   API에 검사를 하드코딩하면 더 단순한 대신 두 번째 인가 어휘가 생긴다.
4. **Kubernetes 접근은 우선순위 목록에서 어디에 위치하는가?** 클러스터 네이티브 충실도(#18/#19)가
   아홉 개 화면 중 하나가 아니라 핵심이라면, 이는 Go를 실질적으로 강화한다.
5. **API에 데이터베이스가 필요한가?** 상관관계 인덱스와 Beluga 소유의 매핑은 영속 상태를
   시사한다. CNPG PostgreSQL 1.30.0이 이미 플랫폼에서 실행 중이고 이 저장소는 이미 PostgreSQL
   DDL을 컴파일하고 있다 — 하지만 두 번째 메타데이터 저장소가 되지 말아야 한다는 상시 규칙을
   고려하면 "Manager가 데이터베이스를 소유한다"는 명시적 결정이 필요하다.
6. **헬스/이벤트를 push할 것인가, poll할 것인가?** #13/#19는 신선도(freshness)를 시사한다.
   Polling이 더 단순하며, SSE/WebSockets는 더 나은 UX를 제공하지만 게이트웨이 설정과 프레임워크
   선택을 제약한다.

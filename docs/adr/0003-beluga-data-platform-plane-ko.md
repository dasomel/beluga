# ADR-0003: Beluga는 데이터 플랫폼 플레인이다

- Status: Accepted (Q1, Q3는 2026-10-07 결정; Q2는 열려 있음)
- Date: 2026-10-02
- Supersedes: —
- Superseded by: —

## 배경

이슈 #99는 Beluga가 Narwhal, KubeMetal, kube-ready-box, ldapium, nfs-quota-agent가 소유한
것을 재구현하지 않고 명시적 계약으로 통합하도록 요구한다. OpenForge 레지스트리
(`portfolio/capability-ownership.json`, `openforge-capability-ownership/v1`)는 역량마다 소유자
하나를 지정하고, 소비자는 중복 구현 대신 통합/소비자 계약 이슈를 만든다고 규정한다.
레지스트리는 `data-platform-lakehouse`를 Beluga(컨트롤 서피스: beluga-manager, 소비자: 없음)에
할당하고, `beluga`를 `kubernetes-platform-control-plane`, `node-runtime-foundation`,
`directory-identity-data-plane`, `local-edge-ai-runtime`, `filesystem-quota-enforcement`의
소비자로 나열한다.

Beluga 자체 기록은 한 가지에서 레지스트리와 다르다. 설계 결정 D11, D13은 게이트웨이와 SSO를
"narwhal 없이 독립 구동"하도록 자체 호스팅하며, `.openforge/status.json`은 Narwhal을 `peer`로
등록하고 [cross-oss-integration-contracts-ko.md](../cross-oss-integration-contracts-ko.md)에서
`not-applicable`로 답했다.

근거 기반 매트릭스는 [portfolio-integration-matrix-ko.md](../portfolio-integration-matrix-ko.md)에 있다.

## 결정

1. Beluga는 **데이터 플랫폼 플레인**이다: 수집, 스트리밍, 레이크하우스 스토리지·카탈로그,
   쿼리, 오케스트레이션, 거버넌스, 데이터 접근 정책, 데이터 플랫폼 의미(#97 분류 A-O 중
   소비하는 플랫폼 기반 항목 제외).
2. Beluga는 레지스트리가 다른 곳에 할당한 역량을 소유하지 않으며 그에 대한 구현 이슈를 열지
   않는다: 클러스터 라이프사이클(Narwhal), 노드 이미지·준비 상태(kube-ready-box), 디렉터리
   라이프사이클(ldapium), 로컬 AI 런타임(KubeMetal), 파일시스템 쿼터 집행(nfs-quota-agent).
   해당 영역의 필요는 소비자 계약 이슈가 된다.
3. 기존 자체 호스팅 중복(Keycloak, APISIX, 부트스트랩 스크립트, LDAP 패키징, 노드 준비)은
   단일 원천과 종료 조건이 지정된 문서화된 예외로 기록한다(매트릭스 2절). 이 ADR이 제거하지 않는다.
4. Beluga / beluga-manager의 OIDC, OPA, Keycloak Seam은 변경하지 않는다. Beluga의 Keycloak은
   데이터 플랫폼 realm의 ID와 롤에 대한 단일 원천으로 유지된다.
5. AI는 선택 사항(#90)이다: 코어 경로는 KubeMetal이나 모델 런타임에 의존하지 않으며
   AI 파생 필드는 결정적 필드를 덮어쓰지 않는다.
6. 소유 저장소에서 근거가 확인되기 전에는 어떤 계약 표면도 사용 가능으로 간주하지 않는다.
   근거 없는 표면은 `unavailable` / *proposed*이며 API 약속이 아니다.

## 검토한 대안

- **Narwhal을 라이프사이클·ID 기반으로 채택** (레지스트리 문자 그대로의 해석) — 지금은
  기각(Q1 결정): D11/D13과 독립 프로파일을 뒤집는다.
- **레지스트리를 무시하고 Beluga를 완전 자립으로 유지** — 기각: #99가 막으려는 중복 구현
  드리프트를 보이지 않게 만든다.
- **모든 경계의 스키마를 지금 작성** — 기각: 형제 저장소는 각자의 세션이 활발히 관리하며,
  Beluga가 만든 스키마는 추측성 계약이 된다.

## 결과

- 매트릭스가 #99 분류의 기준이 된다: 소유된 역량에 닿는 새 Beluga 이슈는 통합 이슈다.
- `portfolio/capability-ownership.json`과 Beluga의 `.openforge/status.json`은 서로 다른 관계
  어휘를 쓴다. Q3는 레지스트리를 확장(`peer`, `unavailable`, `not-applicable`)하는 쪽으로 결정되어
  `.openforge/status.json`은 고쳐 쓰지 않는다. 이 파일이 쓰는 값(`provides`, `consumes`, `peer`,
  `unavailable`, `not-applicable`) 중 `provides`만 레지스트리 허용 집합 밖에 남으며, 정리는 별도
  후속 작업이다. OpenForge 레지스트리 변경이 반영되기 전까지 매트릭스는
  양쪽을 함께 보고한다.
- 현재 Beluga 산출물 일부가 종료 조건이 있는 예외로 명시되며, 후속 작업이 생기지만 즉각적인
  동작 변경은 없다.

## 열린 질문 (소유자 결정 필요)

| ID | 질문 | 중요한 이유 | 제안 소유자 |
|---|---|---|---|
| Q1 | **2026-10-07 결정:** Beluga는 독립 프로파일(D11/D13)의 Narwhal `peer`이며 `kubernetes-platform-control-plane`을 소비하지 않는다. 레지스트리의 소비자 항목 정정은 OpenForge의 후속 작업으로 남아 있다. | 레지스트리와 `.openforge/status.json`이 불일치했다. | 포트폴리오 소유자(OpenForge) |
| Q2 | Beluga가 Narwhal 위에 호스팅되는 경우 Narwhal의 Keycloak realm과 APISIX를 공유할 수 있는가, 데이터 플랫폼 realm은 분리해야 하는가? | beluga-manager와의 OIDC/RBAC Seam을 정의한다. | Beluga + Narwhal + beluga-manager |
| Q3 | **2026-10-07 결정:** `peer`, `unavailable`, `not-applicable`을 레지스트리 `allowed_relationships`에 추가한다. `.openforge/status.json`은 고쳐 쓰지 않는다. `provides` 값은 여전히 미등재(후속 작업). | `.openforge/status.json`이 레지스트리에 없는 값을 썼다. | OpenForge |
| Q4 | `ldapium:charts/ldapium`을 의존성으로 채택하는가, Beluga 렌더 LDAP 매니페스트를 유지하는가? | LDAP 패키징 중복(D5)을 없애지만 GitOps 소유권이 바뀐다. | Beluga + ldapium |
| Q5 | Beluga가 관측성을 직접 배포하는가, Narwhal의 것을 소비하는가, 보류하는가? `VERSIONS.md`에 Prometheus Stack이 있으나 배포된 것은 없다. | 드리프트 후보(D8); 용량 증거·운영 작업을 막는다. | Beluga |
| Q6 | Beluga가 읽는 준비 상태 증거 스키마를 누가 정의하는가: kube-ready-box의 `kube-ready-readiness/v1`인가, Beluga의 `ready` + `findings[]` 게이트인가? | 현재 두 가지가 다르다(매트릭스 3.3). | Beluga + kube-ready-box |
| Q7 | Beluga가 NFS/RWX 스토리지를 도입할 것인가? | nfs-quota-agent가 `not-applicable`로 남는지 결정한다. | Beluga |
| Q8 | 첫 KubeMetal 소비 지점은 어디에 두는가(#80, #90), Vagrant 클러스터에서 macOS 호스트 런타임까지의 네트워크 경로는? | 호출자가 생기기 전에는 어댑터 작업이 정당화되지 않는다. | Beluga + KubeMetal |
| Q9 | `nightly-4e85165`를 대체할 ldapium 릴리스 태그는 무엇이며 2.6.14인가 2.6.15인가? | 릴리스 태그 계약이 `partial`이다. | ldapium |

## 영향 받는 표준, 템플릿, 프로젝트

- `docs/portfolio-integration-matrix-ko.md`(및 영문), `docs/cross-oss-integration-contracts-ko.md`
- 관련: ADR-0001(독립 Vagrant + k3s + GitOps), 이슈 #90, #97, #99
- 읽기 전용 참조: OpenForge, Narwhal, KubeMetal, kube-ready-box, ldapium, nfs-quota-agent
  (여기서 해당 저장소 변경은 제안하지 않음)

## 마이그레이션 / 도입

없음. 문서 전용이다. Accepted 승격에 필요했던 Q1, Q3의 답이 2026-10-07에 나왔다. Q2는 열려 있으며 향후 Narwhal 호스팅 프로파일에만 영향을 준다.

## 근거 및 참고

- `openforge:portfolio/capability-ownership.json`, `openforge:docs/portfolio-capability-ownership.md`
- [portfolio-integration-matrix-ko.md](../portfolio-integration-matrix-ko.md)
- `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md` (D11, D13, D14)
- 이슈 #99 2026-09-18 코멘트 (Narwhal을 `peer`로 해소)

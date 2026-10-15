# ADR-0005: beluga-manager를 beluga 모노레포로 통합

- Status: Accepted
- Date: 2026-10-15
- Supersedes: [manager/docs/adr/0005](../../manager/docs/adr/0005-deployment-gitops-integration-ko.md) (Beluga와의 배포 및 GitOps 통합)
- Superseded by: —

결정 ID: D-MONO-1(CI), D-MONO-2(정책 seam), D-MONO-3(이 ADR). 저장소 import와 CI/seam 연결은
`feat/import-beluga-manager` 브랜치에 있다.

## 배경

`beluga`(Kubernetes 데이터 플랫폼: Bash/Helm/Python)와 `beluga-manager`(TypeScript/Node
npm-workspaces 컨트롤 플레인: `domain-api`, `policy-compiler`, `web`)는 두 저장소로 나뉘어 있었고,
Git 저장소가 아닌 umbrella 워크스페이스에서 조율했다.

- **manager는 독립 배포 대상이 없다.** 업스트림 호스트는 하드코딩된 `*.local.beluga.internal`이고,
  어댑터는 stub뿐이며, 자체 ADR-0005가 제안한 chart/`Application`은 구현된 적이 없다. 그 호스트를
  정의하는 플랫폼 옆에서만 의미가 있다.
- **정책 seam이 pin에 의존했다.** `policies/`는 manager의 `policy-compiler`가 `trino.rego`와
  `db-roles.sql` 생성 구간으로 컴파일하고 test 14가 그 결과를 diff한다. `ci.yml`과 `release.yml`은
  beluga-manager를 서로 다른 고정 SHA로 체크아웃했고, `ci.yml`의 pin(`a63db0b`)은 manager main보다
  import 시점(`93869de`) 기준 118커밋 뒤처져 있었으며, 컴파일러 계약 변경은 다른 저장소에서 수동 pin 갱신이 필요했다.
- 교차 저장소 변경(컴파일러 + 재생성 산출물)은 원자적으로 리뷰·머지할 수 없는 두 PR이 필요했다.

## 결정

1. beluga-manager를 전체 이력과 함께 이 저장소의 `manager/`로 import한다.
2. **D-MONO-1:** `manager/`는 자체 `package.json`/락 파일을 유지하고, 경로 필터가 걸린 워크플로
   `.github/workflows/manager-ci.yml`(`manager/**`만, `working-directory: manager`)과 `/manager`용
   npm Dependabot 항목을 둔다. 공통 관심사(문서, SAST, 공급망)는 beluga 워크플로가 계속 담당한다.
3. **D-MONO-2:** test 14와 `ci.yml`/`release.yml`은 같은 트리의 `manager/`에서 정책 컴파일러를
   실행한다. 고정된 beluga-manager 체크아웃은 제거한다.
4. **D-MONO-3:** 이 ADR이 manager의 ADR-0005를 대체한다. manager 전용 배포 chart/`Application`은
   추진하지 않으며, manager의 클러스터 내 배포는 이 저장소 `docs/adr/`의 새 ADR로 다룬다.

## 결과

- 컴파일러 변경과 재생성된 `trino.rego`/`db-roles.sql`이 한 PR에 들어가므로 seam 게이트가
  컴파일러와 어긋날 수 없다.
- manager는 플랫폼과 독립적으로 릴리스한다: CI는 경로 필터링되고 버전 관리는 그대로다.
  beluga 전용 PR은 manager CI를 실행하지 않는다.
- 저장소 전역 검사(lint, validate, docs, research, SAST)가 `manager/`도 보게 된다. manager가 자체
  동등 검사를 가진 중복 검사는 범위에서 제외하되, 보안 스캔은 절대 제외하지 않는다.
- 완료: 열린 beluga-manager 이슈 22건을 `area:manager` 라벨로 이 저장소의 #239-#260으로 이전했다.
  기존-신규 번호 매핑은 [이 코멘트](https://github.com/dasomel/beluga/issues/239#issuecomment-6186301298)에 있다.
- 대기: 이 브랜치가 머지된 뒤 `dasomel/beluga-manager`를 `manager/` 안내와 함께 아카이브한다.
- OpenForge: manager의 별도 포트폴리오 항목은 `beluga` 프로젝트로 합친다. `policy-compiler` 역량을
  루트 `.openforge/status.json`으로 옮기고 `manager/.openforge/status.json`은 제거한다.
  `dasomel/openforge` 레지스트리의 `beluga-manager` 항목 정리는 그쪽에서 추적한다.
- Research evidence: `manager/research/`는 루트 research-evidence 게이트가 검증한다(D-MONO-4).
  evidence의 `revision`은 import 이후 SHA로 재매핑했고 원본은 `metadata.pre_import_*`에 보존했다.

## 검토한 대안

- **두 저장소를 유지하고 pin을 더 자주 올림** — 기각: 비원자적 교차 저장소 변경과 이미 118커밋을
  놓친 수동 단계가 그대로 남는다.
- **컴파일러를 버전 관리되는 npm 패키지로 배포** — 기각: 소비자가 하나뿐인 도구에 릴리스
  파이프라인을 추가한다.
- **Git submodule** — 기각: 여전히 pin이며 기여자와 CI에 불편하다.

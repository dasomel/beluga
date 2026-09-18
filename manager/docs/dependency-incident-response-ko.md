# 의존성 인시던트 대응

이 저장소에서 손상되었거나(compromised) 회수된(yanked) npm 의존성을 처리하는 절차: 격리
(quarantine), 롤백, 오프라인 검증, 긴급 우회(emergency bypass). issue #47의 남은 공급망
(supply-chain) 요구사항을 위해 작성되었습니다.

## 이미 다루고 있는 부분

이 프로젝트는 컨테이너 이미지나 복잡한 빌드가 없는 소규모 npm/TypeScript 프로젝트이며,
"신뢰된 의존성 집합"과 "재현 가능한 검증"에 필요한 대부분을 기존 tooling이 이미 제공합니다.

- **`package-lock.json`(커밋됨)이 승인된 의존성/아티팩트 집합입니다.** 모든 의존성의 정확한
  resolved version과 `integrity`(SRI hash)가 여기에 고정(pin)되어 있습니다. 어떤 변조나
  치환도 `npm ci`를 즉시 실패시킵니다.
- **`npm ci`(`.github/workflows/ci.yml`의 `test` job에서 사용)가 재현 가능한 검증
  메커니즘입니다.** 정확히 lockfile에 명시된 대로만 설치하며, `package.json`과
  `package-lock.json`이 불일치하면 진행을 거부하므로 조용히 drift할 수 없습니다.
- **`dependency-diff` CI job**(`ci.yml`의 `actions/dependency-review-action`)이 PR마다
  `package-lock.json`에 대한 모든 direct/transitive 변경을 검토합니다.
- **14일 Dependabot cooldown**(`.github/dependabot.yml`, `cooldown.default-days: 14`)은 막
  발행된 릴리스의 채택을 지연시키며, 이 기간은 공급망 침해(예: `dependabot.yml`에서 언급된
  2026-08 Rust 인시던트)가 전형적으로 주입되는 시점입니다.
- **Git history가 last-known-good 스냅샷 저장소입니다.** `package-lock.json`이 커밋되어
  있고 `main`으로의 모든 push가 `test` job을 실행하므로, last-known-good 상태는 단순히
  CI가 green이었던 가장 최근 커밋의 lockfile입니다.

실제로 빠져 있는 것은 *프로세스*입니다: 의존성이 flag된 순간 무엇을 해야 하는지이지, 새로운
tooling이 아닙니다.

## 격리(Quarantine) 절차

이미 `package-lock.json`에 존재하는 의존성이 compromised 또는 yanked로 flag된 경우:

1. **compromised 버전이 도입되기 전의 마지막 green 커밋을 식별합니다.**
   ```bash
   git log --oneline -- package-lock.json
   git show <commit>:package-lock.json | grep -A2 '"<package-name>"'
   ```
2. **해당 커밋에서 해당 패키지의 last-known-good lock 상태를 추출**하고
   (`git show <commit>:package-lock.json`), 식별된 커밋의 해당 CI 실행이 green이었음을
   확인합니다.
3. **패키지를 last-known-good 버전 + integrity hash로 고정**하여 어떤 transitive 경로로도
   재도입되지 않도록 차단합니다. npm의 `overrides` 필드를 `package.json`에 사용합니다:
   ```json
   {
     "overrides": {
       "<package-name>": "<last-known-good-version>"
     }
   }
   ```
   그 다음 `npm install`을 실행하여 override가 적용된 lockfile을 재생성하고, 결과
   `package-lock.json`의 `<package-name>` `integrity` hash가 last-known-good 커밋의
   hash와 일치하는지 확인합니다.
4. **수정 사항을 검증합니다**: `npm ci`, `npm test`, `npm audit`. upstream이 cooldown을
   지난 패치된 릴리스를 배포하고 audit이 clean해지면 `overrides` 항목을 제거합니다.

## 롤백 재현성

`git checkout <last-good-commit> -- package.json package-lock.json && npm ci`는
last-known-good 의존성 트리를 결정론적으로(deterministically) 재현합니다. 두 파일은 반드시
함께 checkout해야 합니다 — `package.json`과 `package-lock.json`이 out of sync이면 `npm ci`는
실행을 거부합니다.

이 저장소를 대상으로 검증됨: 커밋 `bfbcdfe`(vitest 5.0.0 이후 bump들 이전)의
`package.json` + `package-lock.json`을 clean한 `node_modules`로 checkout하고 `npm ci`를
실행한 결과 `0 vulnerabilities`로 성공적으로 완료되어, 해당 커밋의 정확한 의존성 트리를
재현했습니다.

## 오프라인 검증

로컬 npm 캐시가 warm 상태이면(이전에 `npm ci`/`npm install`을 실행한 적이 있으면), 네트워크
접근 없이 의존성 집합을 검증할 수 있습니다:

```bash
npm ci            # 캐시를 warm 합니다
rm -rf node_modules
npm ci --offline  # 네트워크 없이 전적으로 캐시에서 재설치합니다
```

이 저장소를 대상으로 검증됨: warm 캐시 이후 `npm ci --offline`은 47개 패키지 모두를
성공적으로 재설치했으며(`0 vulnerabilities`), 커밋된 lockfile이 오늘 기준 완전히 오프라인
상태에서 재현 가능한 의존성 검증에 충분함을 확인했습니다.

## 긴급 우회(Emergency bypass)

긴급 보안 패치는 14일 Dependabot cooldown을 건너뛸 수 있지만, 다음 제약 조건 하에서만
가능합니다:

- **human-reviewed PR**이어야 하며, 절대 auto-merge되어서는 안 됩니다 — cooldown은 검토되지
  않은 채택을 늦추기 위해 존재하므로, 이를 우회하는 것은 오히려 review bar를 낮추는 것이
  아니라 높이는 것입니다.
- PR 설명에는 우회를 정당화하는 **보안 권고(GHSA/CVE)를 링크**해야 합니다.
- 변경 사항은 **위의 롤백 절차로 되돌릴 수 있어야** 합니다 — 패치 자체가 문제가 있는 것으로
  판명될 경우 `git checkout <pre-patch-commit> -- package.json package-lock.json && npm ci`가
  이전 상태를 복원할 수 있음을 merge 전에 확인합니다.

## 범위 외

완전한 air-gapped registry mirroring(예: 설치된 모든 패키지를 캐싱하는 private npm proxy)은
구현되어 있지 않으며 이 규모의 프로젝트에는 적절하지 않습니다 — 커밋된 lockfile과 warm한
local/CI npm 캐시만으로도 이 저장소가 실제로 사용하는 의존성 집합에 대한 재현 가능한 오프라인
검증을 이미 제공합니다. 만약 플랫폼이 사전 캐시도 네트워크도 전혀 없는 상태에서 의존성을
설치해야 하는 상황이 온다면, registry mirror가 필요하며 그때 재평가해야 합니다.

# 트러블슈팅

이 문서는 Beluga Manager 저장소에서 로컬 개발, 테스트 및 CI 실행 중 발생할 수 있는 실제 검증된 장애 모드를 다룹니다. 각 항목은 증상, 근본 원인 및 단계별 해결 방법을 설명합니다.

English version: [troubleshooting.md](troubleshooting.md)

## 1. `npm run policyctl` 실행 시 `Cannot find package 'tsx'` 실패

### 증상

`npm run policyctl`을 통해 policy compiler CLI를 실행할 때 다음과 같은 ESM 모듈 해석 오류가 발생합니다:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from ...
```

### 원인

`policyctl` CLI는 TypeScript로 작성되어 저장소 루트의 `devDependency`인 `tsx`를 통해 실행됩니다. Beluga Manager를 새로 clone했거나, `dasomel/beluga` 등의 외부 도구 및 형제 저장소에서 사전 의존성 설치(`npm install`) 없이 `policyctl`을 직접 호출할 때 `node_modules/tsx`가 존재하지 않아 발생합니다.

### 해결 방법

저장소에는 [`scripts/ensure-policyctl-deps.sh`](../scripts/ensure-policyctl-deps.sh) 스크립트가 포함되어 있으며, `package.json`의 `npm run policyctl` 실행 시 자동으로 먼저 호출됩니다. 이 스크립트는 `node_modules/tsx`가 없으면 `npm ci`를 통해 의존성을 결정론적으로 자동 부트스트랩합니다.

만약 npm 스크립트를 거치지 않고 CLI 바이너리나 TypeScript 소스를 직접 실행하는 경우, 저장소 루트에서 먼저 의존성을 설치하십시오:

```bash
npm install
# 또는
npm ci
```

## 2. Git worktree에서의 가짜 TypeScript 컴파일 오류 (워크스페이스 심링크 불일치)

### 증상

추가 git worktree에서 `npm run typecheck` 또는 `npm run build`를 실행할 때 다음과 같은 의아한 타입 체크 또는 모듈 해석 오류가 발생합니다:

```text
Cannot find module '@beluga-manager/domain-api/schema' or its corresponding type declarations.
```

또는 현재 worktree 브랜치에 분명히 존재하는 신규 추가 타입이나 스키마 export를 TypeScript가 인식하지 못합니다.

### 원인

이 npm 워크스페이스에서 `@beluga-manager/web`은 `node_modules/@beluga-manager/` 아래에 생성된 심링크를 통해 `@beluga-manager/domain-api`의 Zod 스키마와 TypeScript 타입을 직접 참조합니다.

새 git worktree를 생성(`git worktree add ...`)하면서 메인 저장소의 `node_modules` 디렉터리를 복사하거나 심링크로 공유할 경우, `node_modules/@beluga-manager/` 안의 심링크가 여전히 *메인 체크아웃*의 디렉터리를 가리키게 됩니다. 그 결과 TypeScript가 현재 worktree 브랜치가 아닌 메인 브랜치의 소스 코드를 읽게 됩니다.

### 해결 방법

새 worktree 루트에서 워크스페이스 심링크를 다시 생성합니다:

```bash
npm install
```

이 명령은 `node_modules/@beluga-manager/*`의 심링크를 현재 worktree의 로컬 패키지로 갱신합니다.

## 3. 샌드박스 및 컨테이너 환경 오류 (IPC 소켓 또는 포트 바인딩 `listen EPERM`)

### 증상

테스트 스위트(`npm test`) 실행 시 CLI/자식 프로세스 테스트에서 다음과 같은 IPC 소켓 오류가 발생하며 실패합니다:

```text
listen EPERM: operation not permitted /tmp/...
```

또는 Domain API 개발 서버(`npm run dev:api`) 실행 시 포트 바인딩 실패가 발생합니다:

```text
listen EPERM: operation not permitted 0.0.0.0:8787
```

### 원인

보안이 제한된 에이전트 샌드박스 환경이나 권한이 제한된 CI 컨테이너에서는 네트워크 리스닝 소켓을 열거나 Node.js/`tsx` 자식 프로세스 간 IPC용 Unix 도메인 소켓을 생성하는 작업이 금지될 수 있습니다.

### 해결 방법

- **저장소 기본 검증**: 네트워크 포트를 열지 않고 Python 기반 린트, 이중 언어 페어링 검사, 링크 유효성 검사, 단위 테스트를 수행하는 `make verify`를 실행하십시오. `make verify`는 샌드박스 환경에서도 정상 작동합니다.
- **대상 지정 단위 테스트**: 자식 프로세스를 띄우거나 네트워크 리스너를 열지 않는 개별 단위 테스트를 실행하십시오:
  ```bash
  npx vitest run packages/web/src/
  npx vitest run packages/domain-api/tests/
  ```
- **전체 테스트 및 개발 서버 실행**: 자식 IPC를 사용하는 테스트(예: `policyctl` CLI 실행 테스트)나 `npm run dev:api` 개발 서버는 소켓 및 루프백 네트워크 권한이 허용된 환경에서 실행하십시오.

## 4. 오프라인 또는 에어갭 환경에서의 의존성 감사 실패 (`npm audit` 네트워크 요구)

### 증상

인터넷 연결이 없는 환경에서 `make audit` 또는 `npm run audit`을 실행하면 다음과 같이 실패합니다:

```text
ERROR: Failed to run npm audit: ...
ERROR: npm audit output is not valid JSON. Network or registry error?
```

### 원인

[`scripts/ci/check-dependency-vulnerabilities.mjs`](../scripts/ci/check-dependency-vulnerabilities.mjs) 스크립트는 내부적으로 `npm audit --omit=dev --json`을 실행합니다. `npm audit`은 최신 보안 권고 데이터베이스 조회를 위해 공용 npm 레지스트리로의 아웃바운드 네트워크 통신을 요구합니다. 에어갭 CI나 오프라인 빌드 환경에서는 이 조회가 실패합니다.

### 해결 방법

- 오프라인 또는 에어갭 환경에서는 로컬에서 완전히 실행되는 `make verify`와 lockfile 기반 재현 가능 검증을 사용하십시오:
  ```bash
  npm ci --offline
  ```
  [의존성 인시던트 대응](dependency-incident-response-ko.md) 문서에 명시된 대로, `package-lock.json`은 모든 의존성의 무결성 해시(`integrity`)를 포함하므로 오프라인에서도 변조 없는 재현 가능한 빌드를 보장합니다.
- 라이선스 정책 검증은 로컬 `package-lock.json`만 읽으므로 오프라인에서도 검사할 수 있습니다:
  ```bash
  node scripts/ci/check-license-policy.mjs
  ```
- 취약점 감사(`npm run audit`)는 인터넷 연결이 있는 환경에서 수행하거나, 내부 미러 레지스트리를 설정하여 실행하십시오:
  ```bash
  npm config set registry <internal-mirror-url>
  ```

## 5. CI에서의 의존성 취약점 또는 라이선스 정책 게이트 실패

### 증상

CI `audit` 작업이나 로컬 `make audit` 명령이 다음 메시지와 함께 실패합니다:

```text
[FAIL] UNSUPPRESSED HIGH/CRITICAL VULNERABILITIES DETECTED
```

또는:

```text
[FAIL] UNAPPROVED LICENSES DETECTED
```

### 원인

새로 도입된 직접 또는 전이 의존성에 High/Critical 등급의 CVE 취약점이 있거나, 허용되지 않은 소프트웨어 라이선스가 사용되었거나, 기존에 등록된 임시 예외의 유효 기간(`expiresAt`)이 만료된 경우입니다.

### 해결 방법

감사 스크립트를 우회하거나 비활성화하지 마십시오. 다음 절차에 따라 처리합니다:

1. **의존성 업데이트 시도**: `npm update <pkg>`를 통해 패치된 버전으로 의존성을 업데이트하거나, 허용된 대체 라이브러리로 교체합니다.
2. **예외 검토 및 등록**: 즉각적인 패치가 어렵고 해당 취약점이 Beluga Manager 런타임에서 도달 불가능함이 확인된 경우(또는 비표준 라이선스가 보안/법무 검토를 거쳐 승인된 경우):
   - 보안 취약점의 경우 [`policies/vulnerability-exceptions.json`](../policies/vulnerability-exceptions.json)에 검토된 예외 항목을 추가합니다.
   - 라이선스의 경우 [`policies/license-policy.json`](../policies/license-policy.json)의 `exceptions` 배열에 검토된 항목을 추가합니다.
3. **필수 필드 작성**: 모든 예외 항목에는 `package`, `reason`, `reviewedBy`, 그리고 만료일(`expiresAt`, ISO `YYYY-MM-DD`)이 반드시 포함되어야 합니다. 기한이 지난 예외는 자동으로 실패 처리되어 방치를 방지합니다.

자세한 설정 예시와 정책은 [개발 가이드 — 의존성 취약점 및 라이선스 정책 검증](development-ko.md#의존성-취약점-및-라이선스-정책-검증)을 참조하십시오.

# Troubleshooting

This guide documents verified failure modes encountered during local development, testing, and CI in the Beluga Manager repository. Each entry details the observed symptom, underlying cause, and step-by-step resolution.

See the [Korean troubleshooting guide](troubleshooting-ko.md) for the Korean version.

## 1. `npm run policyctl` fails with `Cannot find package 'tsx'`

### Symptom

Invoking the policy compiler CLI via `npm run policyctl` fails with an ESM module resolution error:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from ...
```

### Cause

The `policyctl` CLI is written in TypeScript and executed via `tsx` (a repository-level `devDependency`). When Beluga Manager is freshly cloned, or when `policyctl` is called directly by external tools or sibling repositories (such as cross-repository integration seam tests in `dasomel/beluga`) without prior dependency installation, `node_modules/tsx` does not exist.

### Fix

The repository provides [`scripts/ensure-policyctl-deps.sh`](../scripts/ensure-policyctl-deps.sh), which is automatically invoked whenever `npm run policyctl` is executed from `package.json`. If `node_modules/tsx` is absent, the script automatically bootstraps dependencies deterministically using `npm ci`.

If you invoke the CLI binary or TypeScript files directly without the npm script wrapper, install dependencies first from the repository root:

```bash
npm install
# or
npm ci
```

## 2. False TypeScript errors in Git worktrees (workspace symlink drift)

### Symptom

Running `npm run typecheck` or `npm run build` in a secondary git worktree produces confusing typecheck or module resolution errors, such as:

```text
Cannot find module '@beluga-manager/domain-api/schema' or its corresponding type declarations.
```

or TypeScript fails to detect recently added type exports and schema changes that physically exist in the local worktree branch.

### Cause

In this npm workspace, `@beluga-manager/web` imports shared Zod schemas and TypeScript types directly from `@beluga-manager/domain-api` via workspace package symlinks located in `node_modules/@beluga-manager/`.

When creating a new git worktree (`git worktree add ...`), if developers copy or reuse an existing `node_modules` directory from the main repository checkout, the symlinks inside `node_modules/@beluga-manager/` still point to the directories of the *main checkout*, rather than the current worktree's files. Consequently, TypeScript reads the source code of the main branch instead of the worktree branch.

### Fix

Re-bootstrap the workspace symlinks inside the root of the new worktree:

```bash
npm install
```

This recreates the symlinks in `node_modules/@beluga-manager/*` to target the worktree's local packages.

## 3. Sandboxed or container environments fail with `listen EPERM`

### Symptom

Running the test suite (`npm test`) fails specifically on CLI/child-process test suites with an IPC socket error:

```text
listen EPERM: operation not permitted /tmp/...
```

or running the Domain API development server (`npm run dev:api`) fails with:

```text
listen EPERM: operation not permitted 0.0.0.0:8787
```

### Cause

Certain sandboxed developer environments, unprivileged CI containers, or restricted test runners forbid opening listening network sockets or creating Unix domain sockets used by Node.js and `tsx` for child-process IPC.

### Fix

- **Repository verification**: Run `make verify`, which executes Python-based linting, bilingual pairing checks, link validation, and unit tests without binding network ports. `make verify` succeeds in restricted sandbox environments.
- **Targeted unit tests**: Run specific unit tests that do not spawn child processes or open network listeners:
  ```bash
  npx vitest run packages/web/src/
  npx vitest run packages/domain-api/tests/
  ```
- **Full tests and dev servers**: For test suites that exercise child IPC (e.g. `policyctl` CLI execution tests) or to run `npm run dev:api`, run in an environment with socket and loopback network permissions.

## 4. `make audit` or `npm run audit` fails in offline or air-gapped environments

### Symptom

Running `make audit` or `npm run audit` in an environment without internet connectivity fails:

```text
ERROR: Failed to run npm audit: ...
ERROR: npm audit output is not valid JSON. Network or registry error?
```

### Cause

The script [`scripts/ci/check-dependency-vulnerabilities.mjs`](../scripts/ci/check-dependency-vulnerabilities.mjs) invokes `npm audit --omit=dev --json` under the hood. `npm audit` requires outbound network access to the public npm registry to fetch active advisory databases. In air-gapped CI or offline build environments, this network request fails.

### Fix

- In offline or air-gapped environments, rely on `make verify` and reproducible lockfile verification:
  ```bash
  npm ci --offline
  ```
  As documented in [Dependency Incident Response](dependency-incident-response.md), `package-lock.json` contains cryptographic SRI hashes (`integrity`) for all dependencies, guaranteeing tamper-proof reproducible builds offline.
- License policy compliance can still be audited offline, as [`scripts/ci/check-license-policy.mjs`](../scripts/ci/check-license-policy.mjs) reads only local `package-lock.json` metadata:
  ```bash
  node scripts/ci/check-license-policy.mjs
  ```
- Run vulnerability auditing (`npm run audit`) only in network-connected environments or configure an internal mirror registry:
  ```bash
  npm config set registry <internal-mirror-url>
  ```

## 5. Dependency vulnerability or license policy gate failure in CI

### Symptom

The CI `audit` job or local `make audit` command fails with:

```text
[FAIL] UNSUPPRESSED HIGH/CRITICAL VULNERABILITIES DETECTED
```

or:

```text
[FAIL] UNAPPROVED LICENSES DETECTED
```

### Cause

A new direct or transitive dependency introduces a high or critical CVE advisory, uses an unapproved software license, or an existing temporary exception has expired past its `expiresAt` date.

### Fix

Do not disable or bypass the audit script. Follow this triage procedure:

1. **Attempt remediation**: Upgrade the affected dependency to a patched version using `npm update <pkg>` or replace the library with an approved alternative.
2. **Review for exception**: If a patch is unavailable and the vulnerability is confirmed unreachable in the Beluga Manager runtime context (or if a non-standard license is reviewed and approved by security/legal):
   - For vulnerability advisories, add a reviewed entry to [`policies/vulnerability-exceptions.json`](../policies/vulnerability-exceptions.json).
   - For licenses, add a reviewed entry to the `exceptions` array in [`policies/license-policy.json`](../policies/license-policy.json).
3. **Ensure required fields**: All exception entries require `package`, `reason`, `reviewedBy`, and a future `expiresAt` date (ISO `YYYY-MM-DD`). Expired exceptions fail automatically to prevent stale suppression.

Detailed configuration examples and guidelines are documented in the [Development Guide — Dependency Vulnerability & License Policy Scanning](development.md#dependency-vulnerability--license-policy-scanning).

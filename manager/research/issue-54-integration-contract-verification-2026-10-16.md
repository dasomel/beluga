# dasomel/openforge#54: beluga-manager-integration-contract verification

Replay date: 2026-10-16  
Revision: `89b609e` (`main`), isolated fresh-session worktree.

## Scope

Replay `.agents/skills/beluga-manager-integration-contract/SKILL.md` to promote from `openforge-maturity: draft` to `verified`.
Following the requirements in `openforge#54` and the previous gap analysis in `issue-54-integration-contract-replay-2026-09-23.md`, this replay tests the now-implemented vertical path:
`upstream-adapter -> correlation/domain API -> Manager UI`.

## Static Workflow Inspection

1. **Adapter Boundary**: `manager/packages/domain-api/src/adapters/` contains upstream adapters (such as Flink adapter under `flinkAdapter.ts` and `flinkClient.ts`). Upstream REST models remain encapsulated within the adapter, classifying failures into `unknown`/`degraded` rather than leaking upstream error payloads into domain APIs.
2. **Correlation Logic**: `manager/packages/domain-api/src/correlation/rules.ts` enforces deterministic correlation rules:
   - Declared labels take precedence with confidence `0.95`.
   - Name convention matching is treated as an inference capped at confidence `0.6` (`NAME_CONVENTION_CONFIDENCE`), reducing to `0.3` (`AMBIGUOUS_CONFIDENCE`) when multiple candidates match.
3. **UI to Domain API Separation**: `manager/packages/web/src/api/client.ts` interacts exclusively with Beluga Domain API routes (`/api/v1/*`). UI views (such as `PipelinesView.tsx` and `ServicesView.tsx`) consume domain entities and `correlationLinks` without direct coupling to upstream Kafka, Flink, or Iceberg endpoints.
4. **Read-First MVP**: The current domain API surface remains read-first without unauthorized mutation endpoints.

## Happy Path

The following deterministic commands were executed from `manager/`:

```bash
make -C manager verify
```
Output:
- Python compileall: OK
- Python unittests: 9 tests in 0.414s, OK
- Python `scripts/verify.py`: Beluga Manager repository verification PASS (required files, bilingual docs, language switchers, links, workflows).

```bash
npm --prefix manager run typecheck
```
Output:
- `@beluga-manager/domain-api`: `tsc --noEmit` PASS
- `@beluga-manager/policy-compiler`: `tsc --noEmit` PASS
- `@beluga-manager/web`: `tsc --noEmit` PASS

```bash
npm --prefix manager test
```
Output:
- Vitest run: 80 test files passed (80), 849 tests passed (849), 0 failed.

```bash
npm --prefix manager run build
```
Output:
- Vite production build for `@beluga-manager/web` built successfully into `dist/`.

## Edge Case

An intentional contract violation was injected into `manager/packages/domain-api/src/correlation/rules.ts`:
Setting `NAME_CONVENTION_CONFIDENCE = 1.0;` (violating rule D2 by presenting an inferred name-convention correlation with higher confidence than declared labels).

Executed:
```bash
npm --prefix manager test packages/domain-api/tests/correlation-rules.test.ts
```
Result:
- Test failed with exit code 1.
- `AssertionError: expected 1 to be less than 0.95` at `tests/correlation-rules.test.ts:33`.
- The suite correctly prevented an uncertain correlation from claiming authoritative status.

Recovery:
Reverted the scratch edit using `git checkout -- manager/packages/domain-api/src/correlation/rules.ts`.
Re-ran `npm --prefix manager test packages/domain-api/tests/correlation-rules.test.ts`:
- 11 tests passed, exit code 0.
- `git status -s` clean.

## Unverified Runtime Scope

- Live multi-service runtime connectivity: live Kafka, Flink, Lakekeeper/Iceberg, Trino, and Airflow clusters were not connected during this offline replay. Flink adapter was validated using recorded 1.20.0 fixtures.
- Domain API authentication and authorization mechanisms remain unverified at runtime.
- Browser accessibility and live interaction: TanStack Table and CodeMirror components were validated via SSR and unit/component tests; live browser DOM, keyboard focus navigation, and clipboard interactions were not tested.

## Decision

The upstream-adapter -> correlation -> domain API -> Manager UI vertical slice is now implemented, deterministic verification passes, and the failure edge case catches contract drift. Promoted `.agents/skills/beluga-manager-integration-contract/SKILL.md` to `openforge-maturity: verified`.

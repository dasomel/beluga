# Security Control-to-Evidence Map

English | [한국어](security-control-evidence-map-ko.md)

A static, repository-derived map from security control areas to the script, test or workflow that verifies them, the Make target that runs it, and the evidence it leaves. It is a bounded first slice of [Issue #50](https://github.com/dasomel/beluga/issues/50) ("Define security baseline and control-to-evidence mapping"), not the full baseline.

> [!IMPORTANT]
> **What this map does not decide.** It assigns no control owners, does not declare which controls are mandatory for any deployment profile, and sets no targets, exceptions or expiry dates. Those are human decisions still open under #50. A status describes only whether an automated verifier exists in this repository; it is **not** a compliance claim, and most verifiers check rendered or declared state, not live behavior.

## Status meaning

- `implemented`: an automated verifier exists and runs in CI at the static tier. Runtime behavior is still unproven.
- `partial`: a verifier covers only part of the area, or only a live-cluster test (not run in CI) exists.
- `gap`: no automated verifier exists in this repository.

Currently 5 implemented, 11 partial, 4 gap.

## Controls

<!-- controls:start -->
| ID | Area | Verifier (script / test / workflow) | Make | Evidence artifact / where produced | Status |
|---|---|---|---|---|---|
| C01 | Identity bootstrap and plaintext endpoints | `scripts/ci/check-identity-bootstrap-ropc.py` `tests/11-identity-plaintext-preflight.sh` | `validate` | Gate stdout and static test 11 in the `make validate` CI log (test 11 also runs in `make test`); tests/10-tls-identity-boundary.sh runs only under `make test`, needs a live cluster and leaves no stored artifact, so it is not cited as a verifier | partial |
| C02 | Access control (authorization defaults, policy compile seam) | `tests/06-authz-defaults.sh` `tests/07-trino-authz-live.sh` `tests/09-seaweedfs-authz-live.sh` `tests/14-policy-compiler-seam.sh` `tests/15-lakekeeper-authz-render.sh` | `test` | Test output only (static tests 14/15 also run in `make validate` and appear in its CI log; 06/07/09 are live-cluster only) | partial |
| C03 | TLS and certificates | `scripts/ci/check-certificate-inventory.py` `scripts/ci/check-kafka-listener-security.py` | `validate` | Certificate inventory JSON on stdout (docs/development.md, #47), not persisted; expiry, renewal and invalid-cert behavior have no verifier | partial |
| C04 | Network segmentation | `scripts/ci/check-networkpolicy-coverage.py` | `validate` | Coverage ratchet in CI log; tests/08-apisix-admin-restrict.sh and tests/16-lakehouse-netpol.sh (enforcement checks) run only under `make test`, is live-cluster only and is not cited as a verifier | partial |
| C05 | Workload runtime hardening (Pod security posture) | `scripts/ci/check-k8s-security-baseline.py` | `validate` | Rendered baseline inventory (stdout, discarded by the Makefile); tests/15-k8s-security-baseline-inventory.py exists but is not wired into make or CI, so it is not cited as a verifier | partial |
| C06 | Gateway request limits (rate, body size) | `scripts/ci/check-apisix-route-rate-limit.py` `scripts/ci/check-apisix-request-size-limit.py` | `validate` | Static render ratchet in CI log; runtime enforcement not verified | implemented |
| C07 | Secrets handling | `scripts/ci/check-identity-bootstrap-ropc.py` `.github/workflows/sast.yml` | `validate` | Inline-secret ratchet in CI log; Trivy secret scan result in the sast.yml Actions run. No rotation or external secret store verifier | partial |
| C08 | Data protection (schema standards) | `scripts/ci/check-data-standards.py` | `validate` | Gate output in CI log; encryption at rest and data-classification controls have no verifier | partial |
| C09 | Backup and recovery | `scripts/ci/check-postgres-backup-config.py` | `validate` | Static backup-config check in CI log; restore drills and non-Postgres stores are not verified | partial |
| C10 | Logging and audit trail | none | none | None | gap |
| C11 | Vulnerability management | `scripts/ci/check-trivy-high-ratchet.py` `.github/workflows/sast.yml` | none | Trivy reports in the sast.yml Actions run; not run by any Make target | partial |
| C12 | Supply chain pinning (images, charts, dependencies, upstream artifacts) | `scripts/ci/check-pin-enforcement.py` `scripts/ci/check-image-tag-immutability.py` `scripts/ci/check-upstream-artifacts.py` `scripts/ci/check-dependency-integrity.py` `scripts/ci/check-version-consistency.py` `tests/test_pin_base_ref.py` `.github/workflows/supply-chain.yml` | `validate` | Gate output in CI log; baselines in scripts/ci/*-baseline.yaml and configs/upstream-artifacts.sha256 | implemented |
| C13 | License and notice compliance | `scripts/ci/check-license-policy.py` `scripts/ci/check-license-change.py` `scripts/ci/check-notice-consistency.py` `tests/test_release_license_inventory.py` | `validate` | Gate output in CI log; release-license-inventory.{json,md} in the release bundle | implemented |
| C14 | Release evidence (SBOM, provenance, checksums) | `scripts/release/evidence_bundle.py` `.github/workflows/release.yml` | `release-evidence` `release-evidence-verify` | Regression test tests/test_release_evidence.py runs in `make validate`; bundle (sbom.cdx.json, license inventory, manifest.json, SHA256SUMS) built by the release workflow with build provenance; no security-control section and no gate on control status | partial |
| C15 | Platform asset inventory | `scripts/ci/check-platform-asset-inventory.py` | `validate` | docs/platform-asset-inventory.md drift check in CI log; declared state only | implemented |
| C16 | Operations agent execution boundary | `tests/13-operations-agent-security.py` `.github/workflows/operations-agent-security.yml` | `test-agent` | Test output and generated plan in the operations-agent-security.yml Actions run | implemented |
| C17 | Incident response | none | none | None | gap |
| C18 | Time-bounded exceptions register | none | none | None | gap |
| C19 | Release readiness gated on control evidence | none | none | None; the release gate checks Trivy runs, lint and validate only | gap |
| C20 | External network dependency inventory (deployment boundary) | `scripts/ci/check-external-endpoints.py` `tests/test_external_endpoints.py` | `validate` | Gate output in CI log; docs/external-dependencies.md and scripts/ci/external-endpoints-baseline.yaml. Inventory of reached hosts only: no restricted-profile allowlist, no data-residency policy, no runtime egress enforcement | partial |
<!-- controls:end -->

`make test` (live-cluster E2E) is listed where a live test exists; CI does not run it.

## Gate scripts out of scope

Every `scripts/ci/check-*.py` must be mapped above or listed here with a reason.

<!-- out-of-scope:start -->
| Script | Reason |
|---|---|
| `scripts/ci/check-ci-stage-parity.py` | Governs CI/Makefile/documentation parity, not a security control itself |
| `scripts/ci/check-run-all-completeness.py` | Test-runner completeness hygiene for tests/run-all.sh |
| `scripts/ci/check-rendered-shell-syntax.py` | Shell syntax correctness of rendered Jobs, not a security property |
| `scripts/ci/check-control-evidence-map.py` | Meta-gate that validates this map itself |
<!-- out-of-scope:end -->

## Enforcement

`python3 scripts/ci/check-control-evidence-map.py` runs in `make validate`. It fails closed when a referenced file or Make target does not exist, when a `check-*.py` gate is neither mapped nor out-of-scope with a reason, when a status is invalid, when a table lacks its header row or has a wrong column count or duplicate ID, when a verifier path is absolute, escapes the repository or is a symlink, when a `gap` row cites a verifier or Make target or another row cites no verifier, when a script or test verifier is not invoked by the recipe of every Make target its row claims (a row must claim only targets that run all its script/test verifiers; prerequisites, `$(MAKE)` calls and `tests/run-all.sh` are followed; backslash continuations are joined first, then `echo` text and `#` comments, including trailing ones, do not count; workflow verifiers are checked for existence only), or when the [Korean pair](security-control-evidence-map-ko.md) drifts in IDs, verifiers, Make targets, status or out-of-scope set. Regression tests: `tests/test_control_evidence_map.py`.

**Limitations.** The recipe check is textual, not a shell or Make evaluation: `if false; then …; fi`, heredoc bodies and `: bash …` lines in `tests/run-all.sh` are still counted as runs; multi-target rules, `$(VAR)` prerequisites and `$(MAKE) -f` are not parsed, so a Makefile edit that uses them can make the gate fail loudly (false FAIL) and must be reflected in the map.

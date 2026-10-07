# Security Verification Gates (inventory, gaps and thresholds)

English | [한국어](security-gates-ko.md)

Baseline and gap analysis for [Issue #31](https://github.com/dasomel/beluga/issues/31) (secure
development and verification gates). **Docs only: no gate, workflow, threshold or policy file is
changed by this document.** Every statement about the repository carries a `file:line` reference read
at the commit this document was written against. Items marked **Proposed** or **Owner decision** have
no basis in the repository and need owner approval before they become policy.

Owner decision already taken (issue #31): the **existing CI gates' HIGH/CRITICAL blocking is the
baseline**. This document therefore records what those gates actually block today, which is narrower
than the issue's wording in two places (see section 4).

Related: [`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (control -> verifier
map, Issue #50) is the control-level view; this document is the gate-level view and the issue #31
acceptance analysis. Profile-specific secure-configuration checks are designed in the environment
profiles document (PR #219, Issue #24).

---

## 1. Gates that exist today

"Blocking" means a failure fails the CI job or the release gate. "Required for merge" is a separate
question (section 3): a blocking CI job only stops a merge if GitHub is configured to require it.

| # | Gate | What it checks | Tool | Blocking | Defined at |
|---|---|---|---|---|---|
| G1 | IaC misconfiguration, CRITICAL | Rendered Helm manifests of every deployed values combination plus `gitops/apps/*.yaml` | Trivy `v0.70.0` (`trivy-action` 0.36.0, SHA-pinned), `scan-type: config`, `exit-code: 1` | **Yes** | [`sast.yml:69-118`](../.github/workflows/sast.yml#L69-L118) |
| G2 | IaC misconfiguration, HIGH (report) | Same scan at HIGH, JSON output | Trivy, `exit-code: 0` | No (visibility) | [`sast.yml:120-129`](../.github/workflows/sast.yml#L120-L129) |
| G3 | HIGH debt ratchet | Any HIGH finding not in the baseline fails; baseline entries no longer present also fail (stale); baseline frozen by digest in code. Baseline today: 9 findings, all `KSV-0014` | `scripts/ci/check-trivy-high-ratchet.py` | **Yes** (new or stale) | [`sast.yml:131-134`](../.github/workflows/sast.yml#L131-L134), [`check-trivy-high-ratchet.py:23`](../scripts/ci/check-trivy-high-ratchet.py#L23), [`trivy-high-baseline.yaml`](../scripts/ci/trivy-high-baseline.yaml) |
| G4 | Secret scan, HIGH and CRITICAL | Whole repo filesystem | Trivy `scanners: secret`, `severity: HIGH,CRITICAL`, `exit-code: 1` | **Yes** | [`sast.yml:136-154`](../.github/workflows/sast.yml#L136-L154) |
| G5 | Shell and chart lint | shellcheck on `scripts/ tests/ demo/`; `helm lint` of both charts | shellcheck, helm | Yes | [`Makefile:41-48`](../Makefile#L41-L48), [`ci.yml:18-35`](../.github/workflows/ci.yml#L18-L35) |
| G6 | Rendered Kubernetes security baseline | runAsNonRoot, privilege escalation, readOnlyRootFilesystem, seccomp, capability drop, privileged/host* and hostPath, exposure inventory | `check-k8s-security-baseline.py` (ratchet) | Yes | [`Makefile:85-86`](../Makefile#L85-L86), [`check-k8s-security-baseline.py:2-22`](../scripts/ci/check-k8s-security-baseline.py#L2-L22) |
| G7 | NetworkPolicy coverage | Every workload namespace needs a real default-deny ingress policy unless baselined (6 namespaces baselined); every covered namespace must also carry a namespace-wide default-deny egress (hard requirement, not baselined); broken "default-deny" with ingress rules and allow-all-egress companion policies always fail | `check-networkpolicy-coverage.py` | Yes (ratchet) | [`Makefile:83-84`](../Makefile#L83-L84), [`check-networkpolicy-coverage.py:2-47`](../scripts/ci/check-networkpolicy-coverage.py#L2-L47), [`networkpolicy-baseline.yaml`](../scripts/ci/networkpolicy-baseline.yaml) |
| G8 | TLS certificate inventory | Rendered `Certificate` durations, renewal windows, DNS names | `check-certificate-inventory.py` | Yes | [`Makefile:81-82`](../Makefile#L81-L82), [`check-certificate-inventory.py:2-6`](../scripts/ci/check-certificate-inventory.py#L2-L6) |
| G9 | Kafka listener TLS/authentication | Rendered Strimzi listeners; two known plaintext/anonymous listeners frozen (issue #6) | `check-kafka-listener-security.py` (ratchet) | Yes (new debt) | [`Makefile:104`](../Makefile#L104), [`check-kafka-listener-security.py:15-25`](../scripts/ci/check-kafka-listener-security.py#L15-L25) |
| G10 | Gateway rate limit and request size | Every externally reachable APISIX route has a rate-limit plugin (known violations baselined); each APISIX ConfigMap sets a finite global request-body limit (no baseline) | `check-apisix-route-rate-limit.py`, `check-apisix-request-size-limit.py` | Yes (ratchet) | [`Makefile:105-106`](../Makefile#L105-L106) |
| G11 | Identity bootstrap hygiene | No ROPC (`grant_type=password`) and no inline secret interpolation in rendered workloads unless baselined | `check-identity-bootstrap-ropc.py` | Yes (ratchet) | [`Makefile:107`](../Makefile#L107), [`check-identity-bootstrap-ropc.py:2-53`](../scripts/ci/check-identity-bootstrap-ropc.py#L2-L53) |
| G12 | Plaintext identity endpoints | Rendered templates contain no non-TLS Keycloak/LDAP URLs | `tests/11-identity-plaintext-preflight.sh` | Yes | [`Makefile:69-70`](../Makefile#L69-L70) |
| G13 | Authorization render contracts | Lakekeeper/OpenFGA on and off render contract; Flink signer token exchange render contract | `tests/15-lakekeeper-authz-render.sh`, `tests/17-flink-signer-token-exchange-render.sh` | Yes | [`Makefile:51-54`](../Makefile#L51-L54) |
| G14 | Policy compiler seam | `policies/` recompiled by beluga-manager equals committed Rego/SQL/Keycloak artifacts | `tests/14-policy-compiler-seam.sh` | Yes | [`Makefile:91-92`](../Makefile#L91-L92), [`ci.yml:59-82`](../.github/workflows/ci.yml#L59-L82) |
| G15 | Pinning and artifact integrity | Immutable image tags; chart/image pin ratchet (19 tag-only images baselined); upstream artifact SHA-256 pins; hashed CI dependencies | `check-image-tag-immutability.py`, `check-pin-enforcement.py`, `check-upstream-artifacts.py`, `check-dependency-integrity.py` | Yes | [`Makefile:71-78`](../Makefile#L71-L78), [`:102`](../Makefile#L102), [`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40) |
| G16 | Supply-chain workflow | `.github/dependabot.yml` present; `VERSIONS.md` present; no `:latest`/`nightly-*`/untagged images in charts (fail-closed allowlist); all workflow `uses:` pinned to 40-hex SHA | shell in workflow | Yes | [`supply-chain.yml:34-112`](../.github/workflows/supply-chain.yml#L34-L112), [`image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt) |
| G17 | Dependency update automation | `github-actions` ecosystem only, weekly, 14-day cooldown (security patches handled manually) | Dependabot | n/a (PR generator) | [`dependabot.yml:7-17`](../.github/dependabot.yml#L7-L17) |
| G18 | License and notice compliance | `VERSIONS.md` licenses against approved list; license changes need a recorded review; NOTICE consistency | `check-license-policy.py`, `check-license-change.py`, `check-notice-consistency.py` | Yes | [`Makefile:63-68`](../Makefile#L63-L68), [`:79-80`](../Makefile#L79-L80), [`policies/license-policy.yaml:12`](../policies/license-policy.yaml#L12) |
| G19 | External endpoint ratchet | New external hosts reached by install/deploy/runtime code | `check-external-endpoints.py` | Yes (ratchet; inventory, not approval) | [`Makefile:114-116`](../Makefile#L114-L116), [`check-external-endpoints.py:2-35`](../scripts/ci/check-external-endpoints.py#L2-L35) |
| G20 | Backup and data standards | CNPG backup config (secretKeyRef, WAL archiving, retention); schema standards | `check-postgres-backup-config.py`, `check-data-standards.py` | Yes | [`Makefile:65-66`](../Makefile#L65-L66), [`:110-111`](../Makefile#L110-L111) |
| G21 | Operations agent boundary | Policy JSON, fail-closed execution boundary, plan smoke test | `make test-agent` (path-filtered workflow) | Yes (only when listed paths change) | [`operations-agent-security.yml:1-56`](../.github/workflows/operations-agent-security.yml#L1-L56) |
| G22 | Control-evidence map consistency | The Issue #50 map points at existing verifiers/targets | `check-control-evidence-map.py` | Yes | [`Makefile:117-119`](../Makefile#L117-L119) |
| G23 | Independent review before merge | `independent-review` commit status for the exact head SHA, posted by a non-author reviewer | `scripts/ci/mark-review-pass.py` | Procedural (any writer can post; not identity proof) | [`AGENTS.md:32-36`](../AGENTS.md#L32-L36), [`mark-review-pass.py:2-13`](../scripts/ci/mark-review-pass.py#L2-L13) |
| G24 | Release gate | Tagged commit on `main`; the newest `sast.yml` push run for that exact commit succeeded with jobs `trivy-config` and `trivy-secrets` all `success`; `make lint`; `make validate` (license gate against previous tag); then evidence bundle build, offline verify, provenance attestation | `release.yml`, `verify_required_checks.py` | **Yes** (release job `needs: gate`) | [`release.yml:54-59`](../.github/workflows/release.yml#L54-L59), [`:61-77`](../.github/workflows/release.yml#L61-L77), [`:113-120`](../.github/workflows/release.yml#L113-L120), [`:122-181`](../.github/workflows/release.yml#L122-L181), [`verify_required_checks.py:17-18`](../scripts/release/verify_required_checks.py#L17-L18) |

Live GitHub settings (queried with `gh api` on 2026-10-07, not stored in the repository, so they have
no `file:line` and must be re-verified): `main` branch protection requires exactly one status check,
`independent-review`; `enforce_admins` is false; no required pull-request reviews; secret scanning and
push protection are enabled; Dependabot security updates are **disabled**; no repository rulesets.

---

## 2. Mapping to the issue's requirements

| Issue #31 requirement | Covered by | Status |
|---|---|---|
| Static analysis | G5 (shell/chart lint), G6, G1-G3 (Trivy IaC). `sast.yml` is scoped to IaC and secrets and describes the repo as having no application source ([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9)), but runnable Python exists: [`scripts/agent/operations_agent.py`](../scripts/agent/operations_agent.py) (operations agent) and the deployed Airflow DAG [`gitops/charts/beluga-data/files/dags/iceberg_maintenance.py`](../gitops/charts/beluga-data/files/dags/iceberg_maintenance.py). What covers them today: `py_compile` and a policy/boundary test for the agent only ([`operations-agent-security.yml:42-44`](../.github/workflows/operations-agent-security.yml#L42-L44)); the DAG is only scanned for image-tag immutability ([`check-image-tag-immutability.py:217-219`](../scripts/ci/check-image-tag-immutability.py#L217-L219)) plus the Trivy secret scan. No Python static analyzer (bandit, ruff, semgrep or similar) runs on either | Covered for IaC/shell; **Gap**: no code-level SAST for the Python code |
| Dependency checks | G15, G16, G17, G18. These check pinning, hashes and licenses. **No known-vulnerability (CVE) scan of any dependency** | **Gap** (pinning yes, vulnerabilities no) |
| Container/image checks | Immutable tags and digest ratchet (G15). **No CVE scan of images in CI**: `sast.yml` states image scanning is not applicable ([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9)); `scripts/generate-sbom.sh` scans a live cluster manually ([`generate-sbom.sh:1-13`](../scripts/generate-sbom.sh#L1-L13), [`RELEASING.md:35-37`](../RELEASING.md#L35-L37)) | **Gap** |
| Manifest/configuration checks | G1-G3, G6, G7, G8, G9, G10, G11, G12 | Covered (ratchets freeze known debt) |
| Authentication/authorization regression tests | Static: G11, G12, G13, G14. Live-cluster tests `tests/06`, `07`, `09`, `10` exist but run only under `make test`, which needs a cluster ([`Makefile:32-33`](../Makefile#L32-L33), [`tests/run-all.sh:19-23`](../tests/run-all.sh#L19-L23)); not run in CI or the release gate ([`docs/security-control-evidence-map.md:26`](security-control-evidence-map.md#L26) row C04: tests 08 and 16 run only under `make test`, live-cluster only) | Static covered; **live not in release verification** |
| TLS regression tests | G8, G9, G12 (static); `tests/10-tls-identity-boundary.sh` live only | Partial |
| Network regression tests | G7, G10 (static); `tests/08`, `tests/16` live only | Partial |
| Secret-handling regression tests | G4, G11, G16 (SHA-pinned actions); no rotation or external secret store verifier ([`security-control-evidence-map.md:29`](security-control-evidence-map.md#L29)) | Partial |
| Data-access regression tests | G13, G14 (static); `tests/07`, `tests/09` live only | Partial |
| Severity thresholds | CRITICAL blocks (G1, G4); HIGH blocks only as new/stale versus a frozen baseline (G3) or in secret scan (G4); MEDIUM/LOW unscanned | Implicit in workflow config, **not documented as policy** until this document |
| Remediation targets | None in the repository. Only "acknowledge reports within 5 business days" for external reporters ([`SECURITY.md:31-35`](../SECURITY.md#L31-L35)) | **Gap** |
| Exception/expiry handling | Exceptions exist as baselines and ignore files (section 5); the gate exception files (section 5) carry no expiry; of them only `license_change_reviews` requires an approver (`approved_by`, [`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63)). A separate mechanism does enforce approver and expiry: the release QA report generator requires `approved_by`, `rationale`, scope (report name + commit) and `expires_on` for waived checks and for accepted findings, and an expired one makes the report not READY ([`generate_release_qa_report.py:106-114`](../scripts/generate_release_qa_report.py#L106-L114), [`:150-167`](../scripts/generate_release_qa_report.py#L150-L167)). It is a manually generated report, not wired into `release.yml` or `make validate` gates (only its regression test runs, [`Makefile:93-94`](../Makefile#L93-L94); [`RELEASING.md:22-23`](../RELEASING.md#L22-L23) asks a human to generate and review it) | **Gap**: gate exceptions (Trivy ignore, baselines, allowlists) lack expiry and, except license changes, an approver; the QA-report mechanism covers release-record waivers/risk acceptances but is not enforced at release and does not govern the gate exception files |
| Release-level security verification evidence | Evidence bundle holds SBOM, license inventory, asset inventory, NOTICE/LICENSE, manifest, checksums, build provenance ([`evidence_bundle.py:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89), [`release.yml:161-181`](../.github/workflows/release.yml#L161-L181)). It contains **no security scan results** and `sast.yml` uploads no artifact (no `upload-artifact` anywhere under `.github`) | **Gap** |
| Prevent release on failed mandatory gates unless approved exception | G24 blocks on `sast.yml` success + lint + validate. An approved-exception path exists only as baseline/ignore edits reviewed in a PR (no release-time exception check) | Partial |
| Secure configuration checks for dev and production-style profiles | G6-G12 run on the default render and, for some gates, the 48/64GB combination ([`networkpolicy coverage COMBOS`](../scripts/ci/check-networkpolicy-coverage.py#L526-L529), [`sast.yml:78-93`](../.github/workflows/sast.yml#L78-L93)). There is no profile concept; see PR #219 | **Gap** (profile-specific) |

Terminology note: `release.yml` calls the SAST runs "vulnerability scans"
([`release.yml:1-3`](../.github/workflows/release.yml#L1-L3)). They are IaC misconfiguration and secret
scans, not CVE scans. Readers of "release blocks on vulnerability scans" should not assume image or
dependency CVEs are covered.

---

## 3. What is mandatory today

| Level | Set | Source of the obligation |
|---|---|---|
| Release-blocking (hard) | G24 itself: on-`main` ancestry, `sast.yml` jobs `trivy-config` + `trivy-secrets` success for the exact commit, `make lint`, `make validate` | [`release.yml:54-120`](../.github/workflows/release.yml#L54-L120) |
| Merge-blocking (hard, GitHub setting) | Only `independent-review` (live setting; procedural, any writer can post) | live `gh api` result above; [`AGENTS.md:35`](../AGENTS.md#L35) says marking checks required is the owner's call |
| CI-blocking but not merge-required | `ci.yml` jobs, `sast.yml`, `supply-chain.yml`, `docs-check.yml`, `operations-agent-security.yml` fail the PR check but are not in the required-checks list | live setting |
| NOT enforced at release | `supply-chain.yml` (SHA-pinned actions, Dependabot/`VERSIONS.md` presence, workflow-level floating-tag grep), `docs-check.yml`, `operations-agent-security.yml`, and the `ci.yml` runs themselves. The release gate checks only: commit on `main`, `sast.yml` jobs `trivy-config`/`trivy-secrets` for the exact commit, then re-runs `make lint` and `make validate` itself | [`release.yml:54-120`](../.github/workflows/release.yml#L54-L120), [`verify_required_checks.py:17-18`](../scripts/release/verify_required_checks.py#L17-L18). Enforcement paths at release: G5 through the separate `make lint` step ([`Makefile:41-48`](../Makefile#L41-L48), [`release.yml:113-114`](../.github/workflows/release.yml#L113-L114)); G6-G15, G18-G20 and G22 through the `make validate` step ([`Makefile:50-124`](../Makefile#L50-L124), [`release.yml:116-120`](../.github/workflows/release.yml#L116-L120)); G1-G4 through the `sast.yml` check; G16's SHA-pinning of actions, G17, G21 and G23 are not |

Observation: `ci.yml` and `release.yml` check out beluga-manager at different pinned SHAs for the
policy compiler seam (`a63db0b...` at [`ci.yml:71`](../.github/workflows/ci.yml#L71) versus
`406663a...` at [`release.yml:100`](../.github/workflows/release.yml#L100)), so the seam gate a PR passes
is not the one a release re-runs.

---

## 4. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| Mandatory security checks are defined and automated | **Partial** | Automated: yes (section 1). Defined as mandatory: only implicitly via G24 and one required status; this document is the first written inventory. Merge-time enforcement of CI jobs depends on a GitHub setting not in the repository |
| Critical/high findings have explicit release-blocking policy or approved exceptions | **Partial** | CRITICAL (IaC, secret) and HIGH (secret; IaC via ratchet) block. Exceptions are recorded (1 CRITICAL path-scoped ignore, 9 HIGH baseline entries) but no expiry and no approver field in those gate files (the license-change store requires `approved_by`; the manual release QA report requires approver and expiry for accepted findings, but is not enforced by the release gate). **No CVE findings exist to block on because no CVE scan runs** |
| Security regression tests run in release verification | **Partial** | Static render-based regression gates run through `make validate` in the release gate. Live-cluster security tests (06-10, 16) do not |
| Security results are retained as release evidence | **Not met** | Bundle excludes scan results; CI runs upload nothing; the Trivy HIGH JSON is a transient file in the runner ([`sast.yml:120-129`](../.github/workflows/sast.yml#L120-L129)) |
| Exception status and expiry are auditable | **Not met** | No expiry field in any gate exception file; the release QA report enforces expiry only for its own waivers/risk acceptances and is not a release gate; no central register; evidence map row C18 "Time-bounded exceptions register" is a `gap` ([`security-control-evidence-map.md:40`](security-control-evidence-map.md#L40)) |

Additional findings: Dependabot security updates are disabled and Dependabot watches only
`github-actions` ([`dependabot.yml:7`](../.github/dependabot.yml#L7)), so no automated dependency
vulnerability signal exists for chart/image versions in `VERSIONS.md`; SAST is path-unfiltered but
cancel-in-progress ([`sast.yml:17-19`](../.github/workflows/sast.yml#L17-L19)), which can make a release
gate fail until it is re-run ([`RELEASING.md:31-34`](../RELEASING.md#L31-L34)).

---

## 5. Exception and expiry mechanism as it exists

| Exception store | Scope | Recorded fields | Expiry / approver | Guard against growth |
|---|---|---|---|---|
| [`.trivyignore.yaml:6-20`](../.trivyignore.yaml#L6-L20) | `KSV-0041`, only `beluga-platform/templates/apisix-gateway.yaml` | id, path, statement | none | path-scoped; otherwise manual review |
| [`scripts/ci/trivy-high-baseline.yaml`](../scripts/ci/trivy-high-baseline.yaml) | 9 `KSV-0014` HIGH findings | rule, chart, kind, namespace, name, container, reason | none | frozen digest in code; new or stale entry fails ([`check-trivy-high-ratchet.py:23`](../scripts/ci/check-trivy-high-ratchet.py#L23)) |
| [`networkpolicy-baseline.yaml`](../scripts/ci/networkpolicy-baseline.yaml) | 6 namespaces without default-deny | namespace, reason, issue | none | stale entry fails; new uncovered namespace fails |
| [`check-kafka-listener-security.py:16-25`](../scripts/ci/check-kafka-listener-security.py#L16-L25) | 2 listeners, issue #6 | attributes, reason, issue | none | exact attributes frozen |
| [`identity-bootstrap-baseline.yaml`](../scripts/ci/identity-bootstrap-baseline.yaml) | ROPC/inline-secret findings | id, reason, issue | none | schema errors fail |
| [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml) | tag-only images | repository, reason (#103) | none | list may only shrink; `BASELINE_CEILING = 19` ([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40)) |
| [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt) | floating-tag exceptions | full image reference | none | entries validated as `registry/path:tag`; fail-closed ([`supply-chain.yml:63-97`](../.github/workflows/supply-chain.yml#L63-L97)) |
| [`check-upstream-artifacts.py:28`](../scripts/ci/check-upstream-artifacts.py#L28) | unverified installer allowlist | entry, reason | none | reviewable growth |
| [`policies/license-policy.yaml:12`](../policies/license-policy.yaml#L12) | `license_change_reviews` (currently empty) | component, new license, named approval, rationale | approver required (`approved_by`, [`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63)); no expiry | exact match required |
| [`external-endpoints-baseline.yaml`](../scripts/ci/external-endpoints-baseline.yaml) | inventory of external hosts | host, phase | none; inventory is not approval | ratchet |

There is no vulnerability exception mechanism in `policies/` (it holds access and license policy
only) and no expiry enforcement for these gate exception files (expiry is enforced only inside the manual release QA report, section 2). An "approved exception" for them today means: a reviewed PR that edits
one of the files above, with the `independent-review` status on its head SHA.

---

## 6. Thresholds and remediation targets

### 6.1 Baseline (adopted by the owner: existing high/critical blocking)

| Severity | Release / CI behavior today | Baseline statement |
|---|---|---|
| CRITICAL | Blocks (IaC config G1; secrets G4) | No release with an unexcepted CRITICAL finding |
| HIGH | Secrets block (G4); IaC blocks on any finding not in the frozen baseline (G3) | No release with a new HIGH finding; existing HIGH debt only as baselined entries |
| MEDIUM / LOW | Not scanned (Trivy runs at CRITICAL and HIGH only) | No policy |

Scope limit that follows from the code: these thresholds apply to IaC misconfiguration and secrets.
They do not apply to vulnerabilities in images or dependencies, which are not scanned.

### 6.2 Proposed (needs owner approval; no repository basis for these numbers)

| Item | Proposal | Reasoning |
|---|---|---|
| Remediation target, CRITICAL | fix or approved exception within 7 days of detection | Mirrors common practice; the repository defines no target. **Owner decision** |
| Remediation target, HIGH | fix or approved exception within 30 days | **Owner decision** |
| Remediation target, MEDIUM | 90 days, non-blocking | **Owner decision** |
| Exception expiry | mandatory expiry, maximum 30 days for CRITICAL and 90 days for HIGH, renewal needs a new named approval | Closes the "expiry auditable" gap |
| Exception register | one version-controlled file (for example `policies/security-exceptions.yaml`) with id, scope, severity, reason, issue, approver, approved-on, expires-on; a checker fails on expired or incomplete entries and is run by `make validate` and by the release gate; existing baselines either feed it or are linked from it | Design only; no script is added here |
| Image/dependency CVE gate | add a CVE scan of rendered chart images at HIGH/CRITICAL (Trivy image scan against the rendered image list that the SBOM step already derives) as a release-gate job, with results written to the evidence bundle | Closes the largest functional gap; needs owner decision on network access in CI and on a new-vulnerability grace period |
| Evidence | add Trivy JSON reports (G2/G3 input, G4 and the new CVE scan) and the exception register to the bundle files covered by `SHA256SUMS` | Makes results retained and attested |
| Live security tests | run `tests/06`-`10`, `16` against a disposable cluster as a manual or scheduled release prerequisite and attach output to the bundle | Cannot run in a stateless runner ([`supply-chain.yml:1-7`](../.github/workflows/supply-chain.yml#L1-L7) makes the same point for SBOM) |
| Required checks | make `ci.yml` validate, `sast.yml` jobs and `supply-chain.yml` required status checks on `main` | GitHub setting, owner action |

---

## 7. Owner decisions needed

1. Approve or change the remediation targets and exception expiry maxima in section 6.2.
2. Approve adding an image/dependency CVE scan to the release gate (and its network/runner implications).
3. Decide whether CI jobs must be required status checks on `main`, and whether `enforce_admins` stays false.
4. Decide whether Dependabot should cover more ecosystems or security updates be enabled.
5. Decide whether live-cluster security tests become a release prerequisite and who runs them.
6. Align the beluga-manager pin used by `ci.yml` and `release.yml` (observation in section 3).

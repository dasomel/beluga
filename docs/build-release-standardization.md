# Build, CI, SBOM, License, Provenance and Release Standardization (Proposal)

English | [한국어](build-release-standardization-ko.md)

Refs issue #100 ("[P1][Engineering][Supply-Chain] Standardize Build / GitHub Actions / SBOM / License / Provenance / Release").

> **Status: PROPOSAL. Documentation only.** No Makefile target, workflow, script, schema or policy is changed by this document.
> Every statement about the repository carries a `file:line` reference read at the commit this document was written against
> (`332b92c`). Live facts (GitHub API, cluster) come from read-only queries on 2026-10-07 and have no `file:line`. External facts
> cite `[S#]` (see [Sources](#sources), accessed 2026-10-07); where no official statement was found the text says so. Items marked
> **Proposed** or **Owner decision** need owner approval first.

Builds on [`security-gates.md`](security-gates.md) (gate ids G15-G24 cited, not restated). Ownership split with the sibling
proposals: acquisition and verification of what is fetched = #103 (`docs/upstream-artifact-verification.md`); image digests,
per-image SBOM, signatures and vulnerability policy = #10 (`docs/image-provenance-sbom-policy.md`); recurring assessment = #37
(`docs/vulnerability-assessment-process.md`). This document owns the **vocabulary, release chain, evidence-bundle contents,
license evidence and formats**. Those files are proposed in sibling pull requests.

The portfolio contract that #100 implements (Narwhal #161) was read only as the issue text in `dasomel/narwhal` through
`gh issue view` on 2026-10-07 [S5]. It lists a common Make target set (`help, fmt, lint, test, security, license, sbom, build, package,
e2e, clean, release`), a CI stage vocabulary (`validate, test, security, license, sbom, build, package, e2e, release, attest`) and
a minimum SBOM metadata set (`artifact, digest, source, version, license, supplier, build_id, commit_sha, workflow_run,
platform/arch, provenance, timestamp`). It is a backlog item, not an adopted specification; this document uses it as the
comparison baseline and does not treat it as binding.

## 1. Current state (verified)

### 1.1 Makefile and CI stages

| Fact | Evidence |
|---|---|
| Makefile targets today: `help up down status test test-agent test-qa-report lint validate release-evidence release-evidence-verify release-evidence-dryrun drift-live clean research-check` | [`Makefile:3`](../Makefile#L3), [`:19-161`](../Makefile#L19-L161) |
| Documented CI stages (a table of workflow step -> Makefile target or a stated non-make reason) are enforced two ways by `check-ci-stage-parity.py` in `make validate`: every documented stage maps to an existing target, and every workflow check step is documented | [`development.md:210-242`](development.md#L210-L242), [`check-ci-stage-parity.py:1-18`](../scripts/ci/check-ci-stage-parity.py#L1-L18), [`Makefile:89-90`](../Makefile#L89-L90) |
| Comparison with the Narwhal #161 vocabulary (section 3.1): present `help`, `lint`, `test`, `clean`; absent as targets `fmt`, `security`, `license`, `sbom`, `build`, `package`, `e2e`, `release`. The functions exist under other names or inside `validate`: license gates are lines of `validate` ([`Makefile:65-70`](../Makefile#L65-L70)); `make test` is the live-cluster E2E ([`Makefile:32-33`](../Makefile#L32-L33)); SBOM and packaging are `release-evidence` | `Makefile` as cited |
| Workflows: `ci.yml` (lint, validate), `sast.yml`, `supply-chain.yml`, `docs-check.yml`, `operations-agent-security.yml`, `research-evidence.yml`, `release.yml`, plus OpenForge status workflows excluded from parity. No scheduled (`cron`) workflow exists | [`.github/workflows/`](../.github/workflows), [`check-ci-stage-parity.py:37-41`](../scripts/ci/check-ci-stage-parity.py#L37-L41); search for `schedule:`/`cron` found none |
| `make validate` runs the static gates (license, pinning, rendered-manifest, evidence-bundle tests) and the release dry run; it needs no cluster | [`Makefile:50-126`](../Makefile#L50-L126) |

### 1.2 Release path

| Fact | Evidence |
|---|---|
| Trigger: push of a tag `v[0-9]+.[0-9]+.[0-9]+*`; strict SemVer name check first; `gate` job (tag on `main`, `sast.yml` jobs `trivy-config`/`trivy-secrets` succeeded for the exact commit, `make lint`, `make validate` with the license gate against the previous tag); `release` job `needs: gate` | [`release.yml:11-16`](../.github/workflows/release.yml#L11-L16), [`:32-120`](../.github/workflows/release.yml#L32-L120), [`:122-123`](../.github/workflows/release.yml#L122-L123); G24 in `security-gates.md` |
| `release` job: `make release-evidence`, `make release-evidence-verify`, `actions/attest-build-provenance` with `subject-checksums: dist/evidence/SHA256SUMS`, `gh attestation verify` per file with `--signer-workflow` and `--source-ref`, then `gh release create` (re-run safe: an existing release is kept only if assets are byte-identical) | [`release.yml:161-203`](../.github/workflows/release.yml#L161-L203) |
| Permissions of the release job: `contents: write`, `id-token: write`, `attestations: write` | [`release.yml:125-128`](../.github/workflows/release.yml#L125-L128) |
| **The path has not run on a real tag**: `gh api repos/dasomel/beluga/releases` and `/tags` returned 0 items on 2026-10-07, and `RELEASING.md` says no tagged release has been cut. Evidence: tests and the dry run only (`make release-evidence-dryrun`, `tests/test_release_evidence.py`) | [`RELEASING.md:5-6`](../RELEASING.md#L5-L6), [`Makefile:134-141`](../Makefile#L134-L141), live query |

### 1.3 Evidence bundle, SBOM and metadata

| Item | State | Evidence |
|---|---|---|
| Bundle files | `manifest.json`, `sbom.cdx.json`, `release-license-inventory.{json,md}`, `platform-asset-inventory.{json,md}`, `NOTICE`, `LICENSE`, `SHA256SUMS` over the eight others | [`evidence_bundle.py:26-35`](../scripts/release/evidence_bundle.py#L26-L35), [`:65-91`](../scripts/release/evidence_bundle.py#L65-L91) |
| Manifest content | `schema`, `version`, `commit`, file names. **No** workflow run id, workflow ref, builder, platform/arch, timestamp or dependency-set reference | [`evidence_bundle.py:87-89`](../scripts/release/evidence_bundle.py#L87-L89) |
| SBOM | CycloneDX 1.5; metadata holds the component `beluga` + version and `beluga:source-commit`; timestamp deliberately omitted for determinism; components = `VERSIONS.md` rows + rendered image references (tags, default values only); no purl/CPE/hash; no supplier | [`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10), [`:103-118`](../scripts/release/generate_sbom.py#L103-L118), [`:112-113`](../scripts/release/generate_sbom.py#L112-L113) |
| Offline `verify` | Needs no network, needs a checkout of the release commit: checksums, no unlisted/missing/symlinked file, manifest vs SBOM commit and version, NOTICE/LICENSE byte-equal to the checkout, asset inventory shape and Markdown equal to the committed doc, SBOM `VERSIONS.md` names equal to the checkout. Documented limit: it proves bundle-internal consistency only; `SHA256SUMS` itself is not attested; authenticity comes from provenance checked with network | [`evidence_bundle.py:114-207`](../scripts/release/evidence_bundle.py#L114-L207), [`development.md:258-268`](development.md#L258-L268) |
| Attestation | GitHub build provenance over the `SHA256SUMS` subjects (so over the digests of every bundle file); not over any deployed container image; "image-digest attestation against a live cluster, and signing of the tag" documented as not covered | [`release.yml:167-170`](../.github/workflows/release.yml#L167-L170), [`development.md:267-268`](development.md#L267-L268) |
| What the bundle does not contain | Security scan results (SAST uploads no artifact), image digests, dependency locks, per-image SBOMs | `security-gates.md` sections 2 and 4 |

### 1.4 Licenses

| Item | State | Evidence |
|---|---|---|
| Machine-readable policy | `policies/license-policy.yaml`: approved license list, own-project marker, `license_change_reviews` (currently empty; requires component, new license, approver, rationale), classifications | [`license-policy.yaml:1-14`](../policies/license-policy.yaml#L1-L14), [`check-license-change.py:63`](../scripts/ci/check-license-change.py#L63) |
| Gates | `check-license-policy.py` (VERSIONS.md vs approved list), `check-license-change.py` (reviewed changes vs a base ref; release uses the previous tag), `check-notice-consistency.py`; all in `make validate`, therefore in the release `gate` | [`Makefile:65-70`](../Makefile#L65-L70), [`:81-82`](../Makefile#L81-L82), [`release.yml:79-85`](../.github/workflows/release.yml#L79-L85), [`:116-120`](../.github/workflows/release.yml#L116-L120) |
| Data source and scope | Licenses are the **declared** values in `VERSIONS.md` (prose, not always SPDX ids); no license is derived from SBOM content, so transitive-package licenses are not covered | [`generate_sbom.py:94-98`](../scripts/release/generate_sbom.py#L94-L98), [`NOTICE`](../NOTICE) states the repository does not compile, vendor or redistribute components |
| `THIRD-PARTY-LICENSES` | No such file exists in the repository (the issue lists it as a scope item) | repository root listing |
| Shipped license evidence | `NOTICE` and `LICENSE` copied verbatim into the bundle and verified byte-equal; the release license inventory is the per-component list | [`evidence_bundle.py:80-81`](../scripts/release/evidence_bundle.py#L80-L81), [`:189-197`](../scripts/release/evidence_bundle.py#L189-L197) |

### 1.5 Declared versus deployed

`check-version-consistency.py` compares `VERSIONS.md` with rendered image tags in `make validate`
([`Makefile:63-64`](../Makefile#L63-L64)). `make drift-live` compares live workload images with the chart render by container
name, skipping upstream-manifest workloads, and is not part of `make validate` or the release gate
([`check-live-drift.py:1-30`](../scripts/ops/check-live-drift.py#L1-L30), [`Makefile:154-155`](../Makefile#L154-L155)).

## 2. Gaps against the acceptance criteria of #100

| Acceptance criterion | Status | Why |
|---|---|---|
| Makefile common target set and documented CI stages match | **Partial** | Makefile <-> documented stages: **met** and gated. The Narwhal vocabulary (section 1.1): 4 of 12 present |
| Every release artifact is linked to source commit and immutable digest | **Partial** | Evidence files: commit in manifest, SHA-256 in attested `SHA256SUMS`. Deployed images: no digest anywhere (#10 proposal) |
| SBOM carries artifact/build/provenance metadata | **Not met** | Only name, version, source commit; no digest, supplier, build id, run, platform, timestamp |
| Difference between deployed images and declared inventory is auto-detectable | **Partial** | `make drift-live` exists but is manual, tag-based and skips upstream-manifest workloads |
| License policy machine-readable and applied at release | **Met** (declared licenses only) | Section 1.4 |
| NOTICE / third-party / license evidence in the release artifact | **Partial** | NOTICE, LICENSE, inventory shipped; no `THIRD-PARTY-LICENSES` file |
| Vulnerability, license, SBOM failure can block a release | **Partial** | License and SBOM: yes. Vulnerability: only IaC/secrets; no CVE scan (`security-gates.md`) |
| Actions run -> artifact -> SBOM -> evidence chain is reconstructable | **Partial** | Run -> evidence files via attestation; evidence files -> SBOM via `SHA256SUMS`; SBOM -> commit. Run id/builder are not in the bundle; the chain was never exercised on a real tag |
| Offline verification reproduces the same evidence check | **Partial** | `verify` is offline for consistency; authenticity (attestation) needs network; locks and scan results are not in the bundle |

## 3. Proposal (all Proposed; owner approval needed)

### 3.1 Make vocabulary: aliases, not renames

| Vocabulary | Beluga today | Proposed mapping |
|---|---|---|
| `help` `lint` `test` `clean` | present | none |
| `fmt` | none; no formatter is run | **Owner decision:** declare "not applicable" in the documented table (no application source, `sast.yml:1-9`), or add shellcheck-style formatting later |
| `security` | `sast.yml` and `supply-chain.yml` workflow steps only | a target running the offline-runnable subset (G4/G15/G16 equivalents) with the Trivy steps documented as workflow-only |
| `license` | lines inside `validate` | target that runs the three license checks |
| `sbom` | `release-evidence` (SBOM is one product) | `sbom` runs only SBOM generation + validation |
| `build` | not applicable: nothing is compiled or built | documented as "n/a, no build artifact" |
| `package` | `release-evidence` | alias of the bundle build |
| `e2e` | `test` (needs a live cluster) | alias, same prerequisites stated |
| `release` | `release-evidence` + CI | alias of the local dry run |

Aliases keep existing names working. `check-ci-stage-parity.py` would extend its documented table with a vocabulary column so a
drifted alias fails `make validate`. Adoption of the vocabulary is an **Owner decision** (it is a portfolio-level contract; the
repository must stay standalone). The stage vocabulary maps onto the workflows as: `validate` = `ci.yml`; `security` = `sast.yml`,
`supply-chain.yml`; `license`/`sbom`/`package`/`attest` = `release.yml` steps; `release` = `release.yml`; `test`/`e2e` = manual
(`make test`); `build` n/a. A per-job stage label is not required.

### 3.2 Release chain: source -> dependency set -> builder -> artifact digest

The chain already has three links (commit in manifest and SBOM; digests of all files in `SHA256SUMS`; attestation over those
digests from a named workflow and ref). **Proposed** additions, each small:

1. Record builder identity in `manifest.json`: workflow ref, run id and run attempt, taken from GitHub-provided environment
   values and validated by strict regex before use (the repository already treats the tag name as attacker-influenced input,
   [`release.yml:37-40`](../.github/workflows/release.yml#L37-L40)). The exact variable names must be taken from the GitHub
   documentation at implementation time (not read for this document). Bump `schema` to a new version; `verify` accepts both for a
   stated period or rejects the old (**Owner decision**).
2. Put the **dependency set** into the bundle: the artifact lock (#103), the image digest lock and image inventory (#10), and the
   scan reports (`security-gates.md` 6.2). Because they are inside `SHA256SUMS`, the existing attestation covers them. This is how
   "source -> dependency set -> builder -> artifact digest" becomes checkable without a new mechanism.
3. State in the manifest which gates ran and their result (names and exit status of lint, validate, SAST check), so the bundle
   says what was enforced; derived from the `gate` job results, not self-asserted by a script that can skip them (the `release` job
   `needs: gate`, [`release.yml:122-123`](../.github/workflows/release.yml#L122-L123)).
4. GitHub documents that artifact attestations alone give SLSA v1.0 Build Level 2 and that reusable workflows can provide the
   isolation for Build Level 3 [S1]; SLSA defines the levels by how hard it is to forge provenance [S2]. Whether the current
   release meets any level was **not assessed** here; claiming one is an owner decision after the path has run on a real tag.
5. Rehearsal: because the path never ran on a real tag (section 1.2), run it once on a pre-release tag (the tag regex allows
   `-rc`-style suffixes, [`release.yml:39`](../.github/workflows/release.yml#L39)) and keep the resulting evidence as the reference.
   Creating a public release object is an **Owner decision**.

### 3.3 Metadata minimum for the SBOM (comparison with Narwhal #161)

| Field | Beluga SBOM today | Proposed source |
|---|---|---|
| artifact, version, license, source | name, version, declared license, `beluga:source` property | unchanged |
| commit_sha | `beluga:source-commit` | unchanged |
| digest | none | `beluga:image-digest` per image (#10); bundle-level digest = attested `SHA256SUMS` |
| supplier | none | **Owner decision:** no source in the repository; `VERSIONS.md` has no supplier column. Do not invent; leave unset or add a column |
| build_id, workflow_run | none | manifest fields of 3.2 item 1 (or SBOM properties copied from them) |
| platform/arch | none | not applicable to the bundle; per image from the digest lock (index digest, #10) |
| provenance | none in the SBOM | attestation reference documented in the manifest |
| timestamp | omitted on purpose (determinism) | keep omitted in the file; the attestation carries signing time; changing this is an owner decision |

### 3.4 SBOM formats

The release SBOM is CycloneDX 1.5; the CycloneDX site currently lists 1.7 and describes standardisation as ECMA-424 [S3]; the
manual content SBOM is SPDX JSON, and SPDX is ISO/IEC 5962:2021 with 3.0 the latest version listed [S4]. The sources read give
no recommendation between the two and no official conversion guidance was read (**no official recommendation**). **Proposed:**
keep both roles as they are (CycloneDX for the declared-state release SBOM, SPDX for Trivy content SBOMs), state the roles in the
documents, and do not convert. Raising the CycloneDX `specVersion` is an **Owner decision** requiring a schema-validation step in
`validate_bom`; recommendation: defer until a consumer requires it.

### 3.5 Licenses

- **Proposed:** declare in `docs/` that the release license inventory is the third-party license evidence while the repository
  redistributes nothing (`NOTICE` says so); do not add an empty `THIRD-PARTY-LICENSES` file. Re-decide when images are built
  or vendored (**Owner decision**; recommendation as stated).
- **Proposed:** state the scope limit in the inventory: licenses are declared per `VERSIONS.md` row; content-derived licenses
  (from the per-image SBOMs of #10) can be added as a second, clearly labelled column rather than replacing the declared value.
- The license exception store keeps `approved_by`; adding an expiry follows the shared exception-register proposal
  (`security-gates.md` 6.2).

### 3.6 Release gates: what must block

Reuse the thresholds and exception design of `security-gates.md` 6.1/6.2 (do not restate them): the release `gate` gains (a) the
image CVE scan job (#10), (b) the artifact-lock and digest-lock checks (already part of `make validate` once #103/#10 land),
(c) the exception-expiry check. License and SBOM failures already abort before a bundle exists
([`evidence_bundle.py:71-72`](../scripts/release/evidence_bundle.py#L71-L72)). Making `ci.yml`, `sast.yml` and `supply-chain.yml`
required status checks on `main` is a GitHub setting listed as an owner action in `security-gates.md`.

### 3.7 Declared-versus-deployed detection

**Proposed:** keep `make drift-live` read-only and manual; extend it to digests once #10 exists; add it as a **release
prerequisite run against a disposable cluster** only if the owner accepts the live-test prerequisite proposed in
`security-gates.md` 6.2 ("Live security tests"). Until then the criterion stays Partial and the report must say so.

### 3.8 Offline verification

**Proposed:** keep `evidence_bundle.py verify` offline; add the new files of 3.2 item 2 to its checks (digest lock equals the
checkout's, inventory matches lock). Document the two verification levels separately in `development.md`: (a) offline consistency
(exists), (b) authenticity with network (`gh attestation verify`, exists in CI). Offline verification of the attestation itself
was not covered by the official pages read; if the owner needs it, that is a separate investigation.

## 4. Verification and test ideas

| Test | Expected | Kind |
|---|---|---|
| Parity check with an alias target missing or an undocumented vocabulary row | `make validate` fails | Offline fixture (extends `check-ci-stage-parity.py` self-tests) |
| Manifest without workflow ref/run id, or with an invalid value | `verify` fails | Offline fixture (extends `tests/test_release_evidence.py`) |
| Bundle missing one of the lock/inventory/scan files, or one altered | `verify` fails | Offline fixture |
| Gate result list contradicts the actual job result | Build aborts | Workflow-level test on a throwaway branch |
| Pre-release tag rehearsal | Release created; `gh attestation verify` passes for every file; `verify` passes from a clean checkout of the tag | Live, once |
| Re-run the release workflow | Existing release kept only if byte-identical | Live (existing behaviour) |
| `THIRD-PARTY-LICENSES` decision | Docs state which file is the evidence | Doc check |

## 5. Owner decisions remaining

| # | Decision | Recommendation |
|---|---|---|
| D1 | Adopt the portfolio target/stage vocabulary as aliases | Yes, aliases only |
| D2 | `fmt` and `build`: declare not applicable | Yes |
| D3 | Manifest schema bump and acceptance of the old schema | Reject the old after one release |
| D4 | Rehearsal on a pre-release tag | Yes, once, before the first real tag |
| D5 | Claim a SLSA level | After the rehearsal; GitHub documents L2 for attestations alone [S1] |
| D6 | CycloneDX spec version upgrade and SBOM format roles | Keep roles; defer upgrade |
| D7 | `THIRD-PARTY-LICENSES` file | Not while nothing is redistributed |
| D8 | `supplier` field source | Leave unset |
| D9 | Live drift check as release prerequisite | With the live-test decision in `security-gates.md` |

## 6. Follow-up implementation tasks (ordered, small)

1. Add vocabulary column and alias targets; extend parity check. *Acceptance:* removing an alias fails `make validate`.
2. Add builder identity and gate results to `manifest.json`; extend `verify` and its tests. *Acceptance:* tampered or missing
   field fails the fixture.
3. Add lock/inventory/scan files to the bundle once #103 and #10 deliver them. *Acceptance:* `SHA256SUMS` lists them; attestation
   verification passes for them on the rehearsal.
4. Rehearsal tag run and recorded results in `docs/` (D4). *Acceptance:* all `gh attestation verify` calls pass; evidence kept.
5. Document verification levels in `development.md` (bilingual). *Acceptance:* `docs-check` passes.
6. License evidence statement and scope limit (3.5). *Acceptance:* doc plus inventory header text, checked by an existing
   inventory test.
7. Digest comparison in `drift-live` (after #10). *Acceptance:* a pod with a different digest is reported `unauthorized`.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | GitHub, Artifact attestations (SLSA v1.0 Build Level 2; reusable workflows for Level 3; `gh attestation verify`): https://docs.github.com/en/actions/concepts/security/artifact-attestations |
| S2 | SLSA v1.0, Levels: https://slsa.dev/spec/v1.0/levels |
| S3 | CycloneDX specification overview: https://cyclonedx.org/specification/overview/ |
| S4 | SPDX specifications: https://spdx.dev/use/specifications/ |
| S5 | `dasomel/narwhal` issue #161 (issue text, read with `gh issue view`; not an official external standard): https://github.com/dasomel/narwhal/issues/161 |

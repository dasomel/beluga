# Image Provenance, SBOM and Vulnerability Policy before Deployment (Proposal)

English | [한국어](image-provenance-sbom-policy-ko.md)

Refs issue #10 ("[P1][Security][SupplyChain] Enforce image provenance, SBOM, and vulnerability policy before deployment").

> **Status: PROPOSAL. Documentation only.** No workflow, script, chart, admission policy or `VERSIONS.md` is changed by this
> document. Every statement about the repository carries a `file:line` reference read at the commit this document was written
> against (`332b92c`). Live-cluster facts come from read-only `kubectl get` on 2026-10-07 and have no `file:line`; they must be
> re-verified. External facts cite `[S#]` (see [Sources](#sources), accessed 2026-10-07); where no official statement was found
> the text says so ("no official recommendation"). Items marked **Proposed** or **Owner decision** need owner approval first.

Builds on [`security-gates.md`](security-gates.md) and cites its gate ids. It reuses, without changing, that document's
**Proposed** remediation targets (CRITICAL 7 days, HIGH 30 days, MEDIUM 90 days), its exception-register design and its image-CVE
gate proposal (section 6.2 there); this document adds the digest, provenance, inventory, admission and offline parts. Acquisition
of non-image artifacts (manifests, charts, jars, pip) is owned by the #103 proposal (`docs/upstream-artifact-verification.md`);
format and release-chain questions by the #100 proposal (`docs/build-release-standardization.md`); the recurring process by the
#37 proposal (`docs/vulnerability-assessment-process.md`). Those files are proposed in sibling pull requests.

## 1. Current state (verified)

### 1.1 Images: tag versus digest

| Fact | Evidence |
|---|---|
| The two charts declare **19 distinct container images**, all referenced by tag, none by digest | [`platform-asset-inventory.md:104`](platform-asset-inventory.md#L104), [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml) lists 19 repositories as "tag-pinned only", ceiling `BASELINE_CEILING = 19` ([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40)) |
| Tags are checked statically for immutability: no `latest`, no branch-like tags, one named exception `ghcr.io/dasomel/ldapium:nightly-4e85165` | [`check-image-tag-immutability.py:106-113`](../scripts/ci/check-image-tag-immutability.py#L106-L113), [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt), [`supply-chain.yml:63-98`](../.github/workflows/supply-chain.yml#L63-L98) (G15, G16) |
| A tag is a name that the registry owner can move. Kubernetes documents digests as immutable content hashes and tags as movable; with both given, only the digest is used to pull | [S1] |
| Live (2026-10-07, read-only): 39 distinct image references in pod specs; 3 carry `@sha256` (Cilium cilium, cilium-envoy, operator-generic, from the upstream chart's own defaults), 36 are tag-only. Every running container reports an `imageID` digest in its status, so the digest that was actually pulled is observable after the fact | `kubectl get pods -A -o jsonpath` (not stored) |
| The ldapium nightly tag resolved live to `ghcr.io/dasomel/ldapium@sha256:33482e83...` | same observation |
| Live-versus-declared image drift is detectable for workloads rendered from the repo charts (name-by-name image comparison), but upstream-manifest and operator workloads are **skipped** and a drifted image there is not detected | [`check-live-drift.py:1-30`](../scripts/ops/check-live-drift.py#L1-L30), `make drift-live` ([`Makefile:154-155`](../Makefile#L154-L155)); not part of `make validate` |

### 1.2 SBOM

| Fact | Evidence |
|---|---|
| Release SBOM: CycloneDX **1.5**, built from (a) the `VERSIONS.md` rows (name, version, declared license) and (b) image references found in `helm template` output of each chart rendered **once with default values** (so images that exist only with the 48/64 GB switches are not in part (b)). It does not scan image contents; no purl, CPE or hash is emitted | [`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10), [`:39-50`](../scripts/release/generate_sbom.py#L39-L50), [`:68-79`](../scripts/release/generate_sbom.py#L68-L79), [`:103-118`](../scripts/release/generate_sbom.py#L103-L118) |
| An image component's `version` is the **tag** (or a digest only if the reference already has one); no digest property exists | [`generate_sbom.py:53-65`](../scripts/release/generate_sbom.py#L53-L65) |
| Content-level SBOM (transitive packages inside images) exists only as a manual command: `trivy image --format spdx-json` per image on a **running cluster**; not in CI, not in the release gate; a failure to pull only warns unless `--check` | [`generate-sbom.sh:41-60`](../scripts/generate-sbom.sh#L41-L60), [`RELEASING.md:35-37`](../RELEASING.md#L35-L37), [`supply-chain.yml:1-7`](../.github/workflows/supply-chain.yml#L1-L7) |
| The evidence bundle's required files are manifest, SBOM, license inventory, asset inventory, NOTICE, LICENSE; no scan result, no image digest, no per-image SBOM | [`evidence_bundle.py:35`](../scripts/release/evidence_bundle.py#L35), [`:87-89`](../scripts/release/evidence_bundle.py#L87-L89) |
| Formats in use: CycloneDX 1.5 (release) and SPDX JSON (manual Trivy). The CycloneDX site currently lists 1.7 (2025-10-21) and describes ECMA-424 [S5]; SPDX is ISO/IEC 5962:2021 [S6] | [S5], [S6] |

### 1.3 Provenance, signatures, admission, vulnerability, offline

| Topic | State | Evidence |
|---|---|---|
| Provenance of internal artifacts | The only attested subject is `dist/evidence/SHA256SUMS` (the evidence files) via `actions/attest-build-provenance`; verified in-run with `gh attestation verify --signer-workflow --source-ref`. Documented as not covered: image-digest attestation against a live cluster and signing of the tag | [`release.yml:167-181`](../.github/workflows/release.yml#L167-L181), [`development.md:244-268`](development.md#L244-L268) |
| Upstream signature verification | **None** in the repository: no `cosign`, `slsa-verifier`, `helm verify` or similar (the one earlier note of the same finding is [`cross-oss-integration-contracts.md:100`](cross-oss-integration-contracts.md#L100)). Whether each upstream publishes signatures: Argo CD documents cosign keyless signatures and SLSA Level 3 provenance for its images and CLI [S7]; the Strimzi documentation page read contains no statement about signatures or SBOMs [S8]; for the 19 chart images this document did **not** survey it (task 2 in section 6) | [S7], [S8] |
| Admission control | No admission policy of any kind (no Kyverno, Gatekeeper, `ValidatingAdmissionPolicy`, policy-controller): a repository-wide search for those names found none outside documentation | search at this commit |
| Vulnerability scanning of images | **None** in CI or the release gate; `sast.yml` scans IaC and secrets and states image scanning is not applicable; `release.yml` calls those "vulnerability scans" ([`sast.yml:1-9`](../.github/workflows/sast.yml#L1-L9), [`release.yml:1-3`](../.github/workflows/release.yml#L1-L3)); see `security-gates.md` section 2 | G1-G4, G24 |
| Severity thresholds and exceptions | IaC/secret thresholds exist (CRITICAL blocks, HIGH blocks only as new vs. a frozen baseline); exceptions carry no expiry; no vulnerability exception mechanism | `security-gates.md` sections 5 and 6.1 |
| Offline / restricted registry use | No profile or script consumes an approved image set without live registries; Trivy-based scanning would need pre-downloaded databases offline [S9]; k3s documents an air-gap path with an images tarball [S10] | [`external-dependencies.md`](external-dependencies.md) (image-registry phase) |
| Release software inventory | The declared-state asset inventory lists images by **tag**, license from `VERSIONS.md`, "lifecycle: declared pin only"; no digest, source field, or scan result | [`platform-asset-inventory.md:104-126`](platform-asset-inventory.md#L104-L126), [`evidence_bundle.py:94-111`](../scripts/release/evidence_bundle.py#L94-L111) |

## 2. Gaps against the acceptance criteria of #10

| Acceptance criterion | Status | Why |
|---|---|---|
| Every production image has an SBOM and immutable digest recorded | **Not met** | Images are listed by tag in the release SBOM; no digest; no per-image content SBOM in the release |
| Provenance/signature policy is evaluated before deployment | **Not met** | No upstream verification, no policy text; own artifact attestation covers evidence files only |
| High/critical vulnerability policy enforced with documented exceptions | **Not met** | Policy exists for IaC/secrets only; no image CVE scan; no expiry-bearing exceptions (`security-gates.md` section 4) |
| An inventory report can be generated for a release | **Partial** | A declared-state inventory is in the bundle (image by tag, version, license); missing digest, source, scan result |
| Policy failure prevents deployment rather than only reporting a warning | **Not met** | No admission or deploy-time check; CI checks block merges only if required (`security-gates.md` section 3); Argo CD syncs repository `HEAD` ([`gitops/apps/beluga-data.yaml:9-10`](../gitops/apps/beluga-data.yaml#L9-L10)) |
| The offline profile can consume the approved artifact set without live registry access | **Not met** | No offline profile; no image export |

## 3. Proposal (all Proposed; owner approval needed)

### 3.1 Digest lock and rendered-image check

- **Proposed:** a version-controlled lock, one line per image reference: `repository:tag  sha256:<digest>` (the digest of the
  manifest the registry serves for that tag; the multi-architecture question below). Initial content from a read-only registry
  query by the person bumping the version, reviewed in the PR, never taken from a running cluster alone.
- **Proposed check (offline):** every image in the chart renders (the same renders `check-image-tag-immutability.py` already
  walks: default, and the 48/64 GB combination, [`check-image-tag-immutability.py:90-98`](../scripts/ci/check-image-tag-immutability.py#L90-L98))
  must have a lock entry with the same tag, and the lock must have no entry that no render uses (stale fails, as in the existing
  ratchets). This is the mechanism that retires `image-digest-baseline.yaml` (shrink to 0, lower `BASELINE_CEILING` accordingly).
- **Proposed deployment form:** `repo:tag@sha256:...` in the charts (readable tag, digest used to pull [S1]). Charts would read
  the digest from values; the exact templating is an implementation detail for task 1.
- Multi-architecture images: `VERSIONS.md` already records an `amd64+arm64` manifest check for at least one row (Lakekeeper), so the lock must pin the **index** digest (one value valid on both) and a test must pull on both architectures;
  per-platform digests would break one host type. The live `imageID` values observed are what the node pulled, and are not
  guaranteed to equal the index digest; the implementation task must confirm with the registry.
- Upstream-manifest images (Argo CD, cert-manager, CNPG operator, Strimzi, Cilium, MetalLB, Flink operator) are not rendered from
  these charts. They are covered by the #103 lock (the manifest hash fixes the image tags inside it, not their digests).
  **Proposed:** extend the digest lock to the images named inside those pinned manifests and Helm charts, produced by a script that
  lists `image:` values from the verified manifests; this is the only way to make `make drift-live` meaningful for them.

### 3.2 SBOM

- **Proposed (release SBOM):** add `beluga:image-digest` as a property next to the existing `beluga:image-reference`
  ([`generate_sbom.py:77`](../scripts/release/generate_sbom.py#L77)), render both profile combinations, and fail the build when an
  image has no lock entry. No new external format fact is needed.
- **Proposed (content SBOM):** a release-prerequisite job that produces one SBOM per locked image **by digest** using the same
  tool and flags as `generate-sbom.sh`, instead of the live cluster, and stores them with the evidence bundle (inside `SHA256SUMS`
  so they are attested). The job needs registry egress and Trivy databases (see 3.6 for offline). The SPDX-versus-CycloneDX choice
  for these files belongs to the #100 proposal (**Owner decision** there); recommendation here: keep Trivy's SPDX output, no
  conversion, until #100 decides.
- Scope statement to keep in every report: the SBOM lists what the tools can see; it is not a completeness proof.

### 3.3 Provenance and signature policy

Policy tiers, applied per image and recorded in the digest lock (a `source` column or sidecar file):

| Tier | Meaning | Check at bump time (human) | Check in CI |
|---|---|---|---|
| A | Upstream publishes verifiable signatures/provenance (for example Argo CD [S7]) | `cosign verify` with certificate identity and OIDC issuer, as the upstream documents [S3]; record the identity | Proposed later: same command by digest, needs network and an owner decision on key/transparency access |
| B | Upstream publishes none (or none found) | Review release notes and digest source; record "no signature available, checked on <date>" | Digest pin only |
| C | Own images (ldapium) | Build with GitHub artifact attestations; consumers verify with `gh attestation verify` [S2] | Verify attestation by digest |

- Own images: GitHub documents that artifact attestations alone give SLSA v1.0 Build Level 2 and that reusable workflows can reach
  Build Level 3 [S2]; SLSA defines L2 as "forging the provenance or evading verification requires an explicit attack" and L3 as
  needing a vulnerability beyond most adversaries' capabilities [S4]. This repository does not build images, so the SLSA level of
  Beluga's own release is a statement about the evidence files only.
- **Proposed:** ask the ldapium project to publish tagged (non-`nightly`) images with attestations; this retires the one
  mutable-tag exception ([`check-image-tag-immutability.py:108`](../scripts/ci/check-image-tag-immutability.py#L108)). Dependency
  on another repository: **Owner decision**.
- The survey of which of the 19 chart images publish signatures is an implementation task; this document makes no claim
  about them.

### 3.4 Vulnerability policy before deployment

- **Proposed:** an image CVE scan of the digest-locked images in the release gate and, as a separate non-blocking report, on a
  schedule (the schedule belongs to the #37 proposal). Thresholds reuse `security-gates.md` 6.1/6.2: CRITICAL blocks; HIGH blocks
  when new relative to a recorded baseline or past its remediation window; MEDIUM reported. Remediation targets 7/30/90 days remain
  **Proposed, Owner decision** there. Whether the scan counts only vulnerabilities with a fix is a policy choice: Trivy can
  restrict by severity and exclude unfixed ones (`--severity`, `--ignore-unfixed`) and supports time-limited ignore entries
  (`expired_at`) and VEX statements [S11]; whether to use them is an **Owner decision** (recommendation: report unfixed, block only
  fixed HIGH/CRITICAL, because a block that cannot be remediated stalls releases).
- **Prioritisation inputs, not thresholds:** CVSS expresses a numeric severity [S12]; EPSS estimates the probability of
  exploitation in the next 30 days [S13]; the CISA KEV catalog is described by CISA as an authoritative source of vulnerabilities
  exploited in the wild to be incorporated into prioritisation [S14]. No source read gives a numeric EPSS cut-off or a
  Beluga-specific rule: **no official recommendation** for thresholds; any such rule is an owner decision.
- **Exceptions:** use the single register already proposed in `security-gates.md` 6.2 (id, scope, severity, reason, issue,
  approver, approved-on, expires-on). Do not create a second exception file for CVEs. A Trivy `.trivyignore.yaml` entry may be
  *generated from* the register so that the scanner and the register cannot disagree.
- Scanner and database versions must be recorded in the report (Trivy databases are fetched at run time and are not pinned by this
  repository today, [`sast.yml:108-111`](../.github/workflows/sast.yml#L108-L111)), otherwise a scan is not reproducible.

### 3.5 Admission-time enforcement (design options, nothing selected)

What can be enforced at admission is limited: an admission controller can check an image reference's form, registry and
signature, not scan for CVEs. CVE policy therefore stays a pre-deployment CI/release gate (3.4); admission is the cluster-side
backstop for digest form, allowed registries and signatures.

| Option | What it can do (per official docs) | Limits / cost |
|---|---|---|
| ValidatingAdmissionPolicy (Kubernetes) | In-process CEL rules, stable since v1.30; actions Deny, Warn, Audit [S15]. A CEL rule on container image strings (for example "must contain `@sha256:`" or "registry in list") is a design to be tested, not a documented recipe | The page read mentions no external data and no signature verification. The cluster runs k3s `1.36` ([`configs/cluster.env:21`](../configs/cluster.env#L21)), above 1.30 |
| Kyverno `verifyImages` | Verifies signatures (Sigstore Cosign and Notary), checks attestations, can mutate tags to digests, `required` defaults to true [S16] | Adds a controller and webhook to a RAM-profiled lab (resource cost not measured); admission webhooks can block bootstrap if unavailable, so `failurePolicy` and namespace scope need design |
| None (CI/release gate only) | Cheapest | "Policy failure prevents deployment" is then true only for changes that go through the gate; a manual `kubectl apply` or an upstream-manifest change is not covered |

**Proposed rollout:** (1) audit/warn only, report violations in `make drift-live`-style output; (2) deny for the namespaces the
charts own, after the digest lock exists; (3) exclude upstream-manifest namespaces until their images are locked. Choice between
the options is an **Owner decision**; recommendation: ValidatingAdmissionPolicy for digest form and registry allow-list first
(no new component), and Kyverno only if signature verification at admission is required by the owner.

### 3.6 Release software inventory and offline use

- **Proposed:** extend the evidence bundle with `image-inventory.json` (+ rendered Markdown): per image: reference, digest, version,
  source (chart / upstream manifest / VERSIONS.md row), license (from `VERSIONS.md`), tier (3.3), SBOM file name and hash, scan
  result summary and report file name, scanner and database version. The offline `verify` step then checks it against the digest
  lock in the release checkout, as it already does for the asset inventory ([`evidence_bundle.py:94-111`](../scripts/release/evidence_bundle.py#L94-L111),
  [`:179-188`](../scripts/release/evidence_bundle.py#L179-L188)). File naming and bundle schema bump are #100 decisions.
- **Proposed offline image set:** images exported **by digest** into an OCI layout or equivalent archive listed in the #103
  artifact bundle, with the digest lock as its index; consumption path = import into the node runtime (k3s documents an images
  tarball placed on the node [S10]) or into a local registry. Vulnerability data offline: pre-downloaded Trivy databases with
  `--skip-db-update`; Java lookups disabled with `--offline-scan` [S9]. Whether an offline profile is in scope at all is an
  **Owner decision** shared with `environment-profiles.md` and #36.

## 4. Verification and test ideas

| Test | Expected | Kind |
|---|---|---|
| Edit a tag in a chart without updating the digest lock | `make validate` fails naming the image | Offline |
| Add a lock entry no render uses | Fails as stale | Offline |
| Release SBOM built from a fixture with an image missing from the lock | Build aborts, no bundle | Offline (extends `tests/test_release_evidence.py`) |
| Evidence bundle with `image-inventory.json` altered, missing or extra | `verify` fails | Offline |
| Registry returns a different digest for a locked tag (fixture registry or recorded response) | Digest-lock refresh check fails | Fixture |
| Scan fixture with a CRITICAL finding, with and without a valid exception entry; with an expired entry | Fails / passes / fails | Offline fixture with recorded scanner JSON |
| Admission (audit): apply a pod with a tag-only image to a throwaway cluster | Warning/audit event; in deny mode, rejected | Disposable cluster (live) |
| Offline import: install from the exported image set with registry egress blocked | Pods start; no external pull | Disposable cluster (live) |

## 5. Owner decisions remaining

| # | Decision | Recommendation |
|---|---|---|
| D1 | Adopt a digest lock and `tag@sha256` form for the 19 chart images | Yes; retire `image-digest-baseline.yaml` |
| D2 | Lock images inside upstream manifests and charts too | Yes, after D1 (needed for drift detection) |
| D3 | Image CVE gate: blocking set (fixed HIGH/CRITICAL vs all), and a grace period for newly published CVEs | Block fixed HIGH/CRITICAL; grace period is an owner number (no official recommendation) |
| D4 | Remediation targets 7/30/90 days (from `security-gates.md`) | Approve as proposed there |
| D5 | Admission control option (3.5) and rollout order | ValidatingAdmissionPolicy audit first |
| D6 | Ask ldapium to publish tagged, attested images | Yes |
| D7 | Signature checks in CI on every run vs. at bump time only | Bump time first |
| D8 | Offline profile in scope | Decide with #36/#24 owners |
| D9 | Content SBOM format (SPDX vs CycloneDX) | Decided in the #100 document |

## 6. Follow-up implementation tasks (ordered, small)

1. Digest lock file plus offline checker against both chart renders; chart templating to emit `tag@digest`. *Acceptance:* a
   changed tag without a lock update fails; `image-digest-baseline.yaml` and `BASELINE_CEILING` reach 0 when done.
2. Survey the 19 chart images for published signatures/attestations from their official docs; record tier A/B per image.
   *Acceptance:* every image has a tier and a dated source link.
3. Add `beluga:image-digest` and the both-profile render to the release SBOM generator. *Acceptance:* a fixture lacking a lock entry
   aborts the bundle build.
4. Scan job on locked digests with recorded scanner/database versions, output stored in the bundle. *Acceptance:* bundle `verify`
   fails if the scan file is absent or altered.
5. Exception register and checker (shared with #37; defined in `security-gates.md` 6.2). *Acceptance:* an expired entry fails `make validate`.
6. `image-inventory.json` generator and offline verify step. *Acceptance:* a locked image missing from the inventory fails verify.
7. Admission policy in audit mode on a disposable cluster (D5). *Acceptance:* a tag-only pod yields an audit/warn event.
8. Extend drift check to compare digests for locked upstream images. *Acceptance:* a pod with a different digest is `unauthorized`.
9. Offline image export/import procedure and test (D8).

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Kubernetes, Images (digest vs tag): https://kubernetes.io/docs/concepts/containers/images/ |
| S2 | GitHub, Artifact attestations (SLSA v1.0 Build Level 2; reusable workflows for Level 3; `gh attestation verify`): https://docs.github.com/en/actions/concepts/security/artifact-attestations |
| S3 | Sigstore, Cosign verify (digest validation, `--certificate-identity`, `--certificate-oidc-issuer`): https://docs.sigstore.dev/cosign/verifying/verify/ |
| S4 | SLSA v1.0, Levels: https://slsa.dev/spec/v1.0/levels |
| S5 | CycloneDX specification overview (version 1.7, ECMA-424): https://cyclonedx.org/specification/overview/ |
| S6 | SPDX specifications (ISO/IEC 5962:2021): https://spdx.dev/use/specifications/ |
| S7 | Argo CD, Signed release assets: https://argo-cd.readthedocs.io/en/stable/operator-manual/signed-release-assets/ |
| S8 | Strimzi, Deploying and managing (searched; no signature/SBOM/cosign statement found): https://strimzi.io/docs/operators/latest/deploying.html |
| S9 | Trivy, Air-gapped environment: https://trivy.dev/latest/docs/advanced/air-gap/ |
| S10 | K3s, Air-Gap Install: https://docs.k3s.io/installation/airgap |
| S11 | Trivy, Filtering (`--severity`, `.trivyignore.yaml` `expired_at`, `--ignore-unfixed`, VEX): https://trivy.dev/latest/docs/configuration/filtering/ |
| S12 | FIRST, CVSS: https://www.first.org/cvss/ |
| S13 | FIRST, EPSS: https://www.first.org/epss/ |
| S14 | CISA, Known Exploited Vulnerabilities Catalog: https://www.cisa.gov/known-exploited-vulnerabilities-catalog |
| S15 | Kubernetes, Validating Admission Policy: https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/ |
| S16 | Kyverno, Verify Images: https://kyverno.io/docs/policy-types/cluster-policy/verify-images/ |

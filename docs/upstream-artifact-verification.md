# Upstream Artifact Verification (Proposal)

English | [한국어](upstream-artifact-verification-ko.md)

Refs issue #103 ("[P0][Security][Supply Chain] Fail-Closed Build Dependency and Upstream Artifact Verification").

> **Status: PROPOSAL. Documentation only.** No workflow, script, chart, lock file, `VERSIONS.md` or policy is changed by this
> document. Every statement about the repository carries a `file:line` reference read at the commit this document was written
> against (`332b92c`). Statements about live state come from read-only `kubectl get` on 2026-10-07 and have no `file:line`; they
> must be re-verified. External facts cite a source `[S#]` (see [Sources](#sources), accessed 2026-10-07); where no official
> statement was found the text says so. Items marked **Proposed** or **Owner decision** have no basis in the repository and need
> owner approval first.

Builds on the gate inventory in [`security-gates.md`](security-gates.md): this document cites gate ids (G15, G16, G17, G19, G24)
rather than restating them, and does not contradict its findings (G15 verifies upstream manifests by SHA-256 but allow-lists two
unverified installers; there is no CVE scan of dependencies). Sibling proposals for the other issues named in #103 (#10, #100,
#37) are separate documents; this one owns the **inventory and verification of what is fetched**, plus cooling, egress,
quarantine and offline use.

The incident the issue cites (a compromised maintainer publishing a package that runs code during build) is taken from the
issue text; it was not re-verified here. The threat model is used only as stated: a fetched artifact is executable, untrusted
input.

## 1. Current state (verified)

"Verified" below means: repository code compares the fetched bytes with a SHA-256 **recorded in this repository** and fails the
step on mismatch. It says nothing about whether the recorded hash itself was reviewed against an upstream signature.

### 1.1 What is fetched, and whether it is verified

| # | Phase | Artifact | Fetched by | Version selector | Verified by repo code? | Evidence |
|---|---|---|---|---|---|---|
| 1 | host-install | Vagrant box `dasomel/ubuntu-26.04-xfs` | `vagrant up` | box name only (no box version or checksum in the file) | **No** | [`Vagrantfile:67`](../Vagrantfile#L67) |
| 2 | host-install | apt package `dnsmasq` | `apt-get install` | distribution default | Not by repo code (relies on the OS package manager; not examined) | [`10-dnsmasq.sh:47-48`](../scripts/cluster/10-dnsmasq.sh#L47-L48) |
| 3 | host-install | k3s installer script, then the k3s binary it downloads | `curl -sfL https://get.k3s.io \| sh -` (server and agent) | release **channel** `v${K8S_VERSION}` (`1.36`), a moving minor line | **No** (allow-listed) | [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32), [`:61`](../scripts/cluster/02-k8s-init.sh#L61), [`check-upstream-artifacts.py:29-30`](../scripts/ci/check-upstream-artifacts.py#L29-L30) |
| 4 | host-install | Helm installer script (`get-helm-3`, Helm `main` branch), only if `helm` is absent | `curl -sfL ... \| bash` | branch `main` (mutable) | **No** (allow-listed) | [`03-cni-metallb.sh:15-17`](../scripts/cluster/03-cni-metallb.sh#L15-L17), [`check-upstream-artifacts.py:31-32`](../scripts/ci/check-upstream-artifacts.py#L31-L32) |
| 5 | host-install | Helm chart `cilium/cilium` | `helm repo add` + `helm upgrade --install --version 1.20.0` | exact chart version | **No** (version pin only; no chart digest, no `--verify`) | [`03-cni-metallb.sh:20-28`](../scripts/cluster/03-cni-metallb.sh#L20-L28) |
| 6 | host-install | Helm chart `metallb/metallb` | same pattern, `--version 0.16.1` | exact chart version | **No** (version pin only) | [`03-cni-metallb.sh:34-39`](../scripts/cluster/03-cni-metallb.sh#L34-L39) |
| 7-17 | deploy-bootstrap | 11 upstream manifests: Argo CD `install.yaml` v3.5.0, cert-manager v1.21.1, CloudNativePG v1.30.0, Strimzi 1.1.0, 7 APISIX CRDs v1.8.0 | `fetch_verified` (curl, `--proto =https`, SHA-256 against the lock, temp file then `mv`) | exact tag in the URL (branch-like URL segments rejected by the lock loader) | **Yes**, fail-closed | [`configs/upstream-artifacts.sha256:3-13`](../configs/upstream-artifacts.sha256#L3-L13), [`verified-fetch.sh:17-42`](../scripts/common/verified-fetch.sh#L17-L42), [`01-argocd-bootstrap.sh:23`](../scripts/gitops/01-argocd-bootstrap.sh#L23), [`:299`](../scripts/gitops/01-argocd-bootstrap.sh#L299), [`:306`](../scripts/gitops/01-argocd-bootstrap.sh#L306), [`:313`](../scripts/gitops/01-argocd-bootstrap.sh#L313), [`:334`](../scripts/gitops/01-argocd-bootstrap.sh#L334) |
| 18 | deploy-bootstrap | Helm chart `flink-kubernetes-operator` 1.15.0 from `downloads.apache.org` | `helm repo add` + `helm upgrade --install --version 1.15.0`, both followed by `\|\| true` | exact chart version | **No** (version pin only) | [`01-argocd-bootstrap.sh:320-326`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L326) |
| 19 | gitops-sync | This repository itself, synced by Argo CD | Argo CD Applications | `targetRevision: HEAD` (self-reference, excluded on purpose from the pin gate) | n/a (own repo) | [`gitops/apps/beluga-data.yaml:9-10`](../gitops/apps/beluga-data.yaml#L9-L10), [`check-pin-enforcement.py:5-6`](../scripts/ci/check-pin-enforcement.py#L5-L6) |
| 20-38 | image-registry | **19 distinct container images** declared by the two charts (tag-only, none by digest) | kubelet pull | tag | **No digest anywhere**; tag immutability is checked statically (G15), tags can still be re-pointed upstream | [`platform-asset-inventory.md:104`](platform-asset-inventory.md#L104), [`image-digest-baseline.yaml`](../scripts/ci/image-digest-baseline.yaml) (19 repositories), [`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40) |
| 39-42 | pod-runtime | 4 Flink jars from `repo1.maven.org` (Kafka SQL connector 3.4.0-1.20, iceberg-flink-runtime 1.7.1, iceberg-aws-bundle 1.7.1, flink-shaded-hadoop-2-uber 2.8.3-10.0); downloaded at **two** sites | `curl` + `sha256sum -c` in an initContainer and in the SQL-submit job; script runs under `set -e` / `set -eu` | exact versions in the URL | **Yes**, fail-closed (hash recorded in the chart) | [`05-flink-operator.yaml:45-56`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L45-L56), [`14-flink-jobs.yaml:84`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L84), [`:98-108`](../gitops/charts/beluga-data/templates/14-flink-jobs.yaml#L98-L108) |
| 43 | pod-runtime | PyPI: `authlib` and `apache-airflow-providers-cncf-kubernetes` plus their transitive dependencies (Airflow pod) | `pip install` at container start | **none** (unpinned, no hashes) | **No** | [`07-airflow.yaml:163`](../gitops/charts/beluga-data/templates/07-airflow.yaml#L163) |
| 44 | pod-runtime | PyPI: `authlib`, `trino[sqlalchemy]` plus transitive dependencies (Superset init container, runs as UID 0) | `uv pip install --target /pylibs` | **none** | **No** | [`08-superset.yaml:102`](../gitops/charts/beluga-data/templates/08-superset.yaml#L102), [`:98`](../gitops/charts/beluga-data/templates/08-superset.yaml#L98) |
| 45 | pod-runtime | PyPI: `kafka-python-ng` 2.2.2 (clickstream generator) | `pip install --target /pylibs` at container start | exact version, **no hash** | **No** (version pin only) | [`13-clickstream-gen.yaml:48`](../gitops/charts/beluga-data/templates/13-clickstream-gen.yaml#L48) |
| 46 | demo-build | `python:3.12-slim` base image and `kafka-python-ng==2.2.2` (not deployed by the charts) | `docker build` | tag / exact version, no hash | **No** | [`demo/clickstream-gen/Dockerfile:2,6`](../demo/clickstream-gen/Dockerfile#L2), [`requirements.txt`](../demo/clickstream-gen/requirements.txt) |

Row numbers 20-38 and 39-42 are artifact counts (19 images, 4 jars), not table rows. Totals from this table: **15 distinct
artifacts verified by repo code** (11 manifests + 4 jars); **not verified by repo code**: 2 install scripts (k3s, Helm) and what
they download, 3 Helm charts, 19 chart images, 3 runtime `pip`/`uv` invocations, the Vagrant box and the apt package.

Images and downloads **brought in by the upstream manifests and charts above are not enumerated by any repository file**
([`external-dependencies.md`](external-dependencies.md), "Known limits"). One read-only observation of the running cluster on
2026-10-07 shows the size of that gap: 39 distinct image references in pod specs, of which 3 carry `@sha256` (all Cilium, from the
chart's own defaults) and 36 are tag-only; one pod spec image is `ghcr.io/apache/flink-kubernetes-operator:79d730b` (a commit-style
tag chosen by the upstream chart) while `VERSIONS.md` records `apache/flink-kubernetes-operator:1.15.0` (the cause was not
investigated). `public.ecr.aws/docker/library/redis:8.2.3-alpine` (Argo CD) appears live and nowhere in the charts. This is one
observation, not a stable fact.

### 1.2 CI and release build-time inputs

| Input | State | Evidence |
|---|---|---|
| GitHub Actions | All 40 `uses:` lines (8 distinct actions) pinned to 40-hex SHAs; checked by a grep gate (G16) | [`supply-chain.yml:100-112`](../.github/workflows/supply-chain.yml#L100-L112) |
| Python (CI) | `pyyaml==6.0.3` with three `--hash` values; `pip install --require-hashes` in `ci.yml` and twice in `release.yml`; a static checker rejects regressions (its own run prints `Dependency integrity OK: 1 pinned requirements; 4 protected installs`) | [`requirements-ci.txt`](../requirements-ci.txt), [`ci.yml:57`](../.github/workflows/ci.yml#L57), [`release.yml:93`](../.github/workflows/release.yml#L93), [`:159`](../.github/workflows/release.yml#L159), [`check-dependency-integrity.py:1-9`](../scripts/ci/check-dependency-integrity.py#L1-L9) |
| Python (research lane) | 6 pinned and hashed packages, separate lock | [`requirements-research.txt`](../requirements-research.txt), [`research-evidence.yml:36`](../.github/workflows/research-evidence.yml#L36) |
| Helm in CI | `v3.16.4` via `azure/setup-helm` (version pinned; the action's download verification was not examined) | [`ci.yml:29-32`](../.github/workflows/ci.yml#L29-L32) |
| Trivy | `v0.70.0` via `trivy-action` (SHA-pinned); Trivy's vulnerability/check databases are fetched at run time and are not pinned by this repository | [`sast.yml:108-111`](../.github/workflows/sast.yml#L108-L111), air-gap page [S6] |
| beluga-manager seam | Checked out at a pinned commit SHA, then `npm ci`; the lock file belongs to the other repository and was not examined. The two workflows pin **different** SHAs (see [`security-gates.md`](security-gates.md) section 3) | [`ci.yml:67-82`](../.github/workflows/ci.yml#L67-L82), [`release.yml:96-111`](../.github/workflows/release.yml#L96-L111) |
| Node | `node-version: '22'` (floating minor) | [`ci.yml:75-78`](../.github/workflows/ci.yml#L75-L78) |
| Runner image | `ubuntu-latest` (floating) | [`ci.yml:19`](../.github/workflows/ci.yml#L19) |
| Egress control | `step-security/harden-runner` is present in every job with `egress-policy: audit` (observe only) | [`ci.yml:24`](../.github/workflows/ci.yml#L24), [`release.yml:45`](../.github/workflows/release.yml#L45), [`:146`](../.github/workflows/release.yml#L146), [`sast.yml:31`](../.github/workflows/sast.yml#L31), [`supply-chain.yml:29`](../.github/workflows/supply-chain.yml#L29) |
| Update cooling | Dependabot `github-actions` only, weekly, `cooldown.default-days: 14`; security patches handled manually (G17) | [`dependabot.yml:7-17`](../.github/dependabot.yml#L7-L17) |

### 1.3 How the existing verification behaves (what is already fail-closed)

- `verified-fetch.sh` rejects a missing/malformed/duplicated lock, an entry without the URL, a download failure and a hash
  mismatch, removes the temp file, and allows only `https` unless a test-only variable is set
  ([`verified-fetch.sh:17-42`](../scripts/common/verified-fetch.sh#L17-L42)).
- `check-upstream-artifacts.py` re-checks that behaviour with 8 negative `file://` fixtures plus protocol-default tests
  ([`check-upstream-artifacts.py:90-132`](../scripts/ci/check-upstream-artifacts.py#L90-L132)), rejects `kubectl -f URL`,
  `curl | sh|bash|kubectl` in `scripts/**/*.sh` unless allow-listed
  ([`:25-26`](../scripts/ci/check-upstream-artifacts.py#L25-L26), [`:54-74`](../scripts/ci/check-upstream-artifacts.py#L54-L74)), and
  rejects lock URLs with `main|master|HEAD|latest|stable|release-*` segments
  ([`:24`](../scripts/ci/check-upstream-artifacts.py#L24), [`:44-45`](../scripts/ci/check-upstream-artifacts.py#L44-L45)).
  Running it at this commit prints `upstream artifact gate OK: 11 pinned artifacts, 2 allowlisted installer scripts`.
- Scope limits that follow from the code: the scan covers `scripts/**/*.sh` only
  ([`:72`](../scripts/ci/check-upstream-artifacts.py#L72)); it does not look at chart templates (so the Flink jar hashes and the
  `pip install` lines in templates are outside it), and it does not cover `helm repo add` charts, container images or workflows.
- Chart and image pinning is a separate ratchet (G15): shell Helm installs need an exact `--version`; images need a non-`latest`
  tag; a repository without a digest must be in `image-digest-baseline.yaml`, whose size may only shrink
  ([`check-pin-enforcement.py:3-14`](../scripts/ci/check-pin-enforcement.py#L3-L14), [`:40`](../scripts/ci/check-pin-enforcement.py#L40)).
  One mutable tag is allowed by name: `ghcr.io/dasomel/ldapium:nightly-4e85165`
  ([`check-image-tag-immutability.py:108`](../scripts/ci/check-image-tag-immutability.py#L108),
  [`.github/image-tag-allowlist.txt`](../.github/image-tag-allowlist.txt)); live, that tag resolved to
  `ghcr.io/dasomel/ldapium@sha256:33482e83...` on 2026-10-07.
- Fail-open spots found while reading the bootstrap: `kubectl apply ... || true` after the verified CNPG and Strimzi downloads
  ([`01-argocd-bootstrap.sh:307`](../scripts/gitops/01-argocd-bootstrap.sh#L307), [`:315`](../scripts/gitops/01-argocd-bootstrap.sh#L315)),
  and `|| true` on the Flink operator repo-add/install ([`:320-326`](../scripts/gitops/01-argocd-bootstrap.sh#L320-L326)). The
  download is verified, but a failed apply of a verified manifest does not stop the script.

## 2. Gaps against the acceptance criteria of #103

| Acceptance criterion | Status | Why (section 1 rows) |
|---|---|---|
| All release inputs are immutable and auditable | **Partial** | Immutable and recorded: 11 manifests, 4 jars, CI PyYAML, SHA-pinned actions. Not immutable: k3s channel, Helm `main` installer, 3 Helm charts (version only), 19 images (tag only), 3 runtime pip/uv installs, Vagrant box, runner image, Node minor |
| Dependency integrity mismatch fails CI | **Partial** | Manifest mismatch is tested offline with fixtures (G15). Flink jar hash mismatch is enforced at pod start, not in CI. No CI test substitutes a jar, a chart or an image |
| A malicious package or build script cannot use unrestricted CI egress | **Not met** | `egress-policy: audit` everywhere; nothing blocks |
| Build-time dependency inventory is in the release SBOM | **Not met** | The release SBOM lists `VERSIONS.md` rows and rendered images only ([`generate_sbom.py:1-10`](../scripts/release/generate_sbom.py#L1-L10)); no jars, no pip packages, no installer scripts, no CI tools. Owned by the #100 proposal; the inventory here is its input |
| Provenance links source -> dependency set -> builder -> artifact digest | **Not met** | Attestation subject is `SHA256SUMS` of the evidence files ([`release.yml:167-170`](../.github/workflows/release.yml#L167-L170)); no dependency set, no deployed-image digest. See the #100 and #10 proposals |
| Compromised-package rollback is reproducible | **Not met** | Rollback is `git revert` plus an Argo CD sync ([`RELEASING.md:39-44`](../RELEASING.md#L39-L44)); no quarantine list, no procedure for yanked versions, tags/pip are not reproducible |
| Offline / air-gapped profile consumes only an approved bundle | **Not met** | No such profile exists; every phase in section 1 reaches the network. Evidence-bundle verification is offline, artifact acquisition is not |
| Negative tests: dependency substitution, yanked version, unexpected egress | **Partial** | Substitution only for the manifest helper (8 fixtures); nothing for yanked versions or egress |

Requirements of the issue not tied to one criterion: "remove/flag `latest`" is met for charts (G16, G15); "dependency cooling"
exists for Actions only (G17); "integrate with #10, #31, #37, #100" is done here by citing gate ids and splitting ownership.

## 3. Proposal (all Proposed; owner approval needed)

### 3.1 One artifact lock, one acquisition path

- **Proposed:** treat `configs/upstream-artifacts.sha256` as the single lock for everything fetched as a file, and extend its
  schema only if needed (for example a name/purpose comment per line). Add: the 4 Flink jars (today hashes live in two chart
  templates and must be edited in both places), Helm chart archives for Cilium, MetalLB and the Flink operator (hash of the `.tgz`;
  `helm pull --version` then `helm install ./file.tgz`), and the k3s installer script at a **tagged commit URL** instead of
  `get.k3s.io`.
- **Proposed:** replace the two allow-listed `curl | sh` lines by `fetch_verified` of an installer at an immutable URL plus an
  exact-version selector. The name of the k3s installer's exact-version variable and whether the installer verifies the binary it
  downloads must be confirmed against the k3s documentation at implementation time: the air-gap page read for this document
  lists the binary, images tarball and install script and **does not mention checksums** [S5]. Helm: download a release tarball
  by exact version and verify its hash instead of `get-helm-3` from `main`.
- **Proposed:** add a `|| true` audit to the bootstrap: each `|| true` after a verified artifact needs a written reason or is
  removed.
- Upstream signatures: Helm documents provenance (`.prov`, `helm verify`, GnuPG signature, served next to the chart) [S4], Maven
  Central requires a `.asc` signature per file [S7], and Argo CD documents cosign keyless signatures and SLSA provenance for its
  release assets [S8]. For Strimzi the documentation page read (1.2.0) contains **no** statement about artifact signatures,
  SBOMs or cosign [S9]. Proposed rule: record the hash after reviewing, and where the upstream publishes a signature, verify it
  once at bump time (by the person updating the lock) and note that in the PR; whether CI should verify signatures on every run is
  an **Owner decision** (needs network access to key/transparency services).

### 3.2 Container images (summary; detail in the #10 proposal)

Digest pinning of the 19 chart images and of upstream-manifest images is designed in the #10 document (image provenance, SBOM,
vulnerability policy). The requirement carried here: a tag whose digest changed between two renders must fail a check, and the
ratchet `BASELINE_CEILING = 19` ([`check-pin-enforcement.py:40`](../scripts/ci/check-pin-enforcement.py#L40)) is the existing
mechanism to shrink to 0. Kubernetes documents that digests are immutable while tags can be moved [S1].

### 3.3 Runtime package installs

Three pods install unpinned or hash-less packages at start. A hash-checked install needs every requirement pinned with `==` and
the whole closure listed, because pip's hash-checking mode requires pinned requirements [S2]. Options:

| Option | Closes | Cost |
|---|---|---|
| A. Ship a hashed requirements file per pod (ConfigMap) and run `pip install --require-hashes` | Substitution at PyPI; unpinned transitive upgrades | Closure must be regenerated per bump; Superset's `rm -rf` of core packages after install (the SQLAlchemy conflict) must be re-tested |
| B. Build derived images with the packages baked in | Runtime egress to PyPI | Contradicts the README statement that components are not built; needs a registry (#10) |
| C. Mirror packages in an approved bundle (offline profile) | Runtime egress | Needs the bundle process of section 3.6 |

**Owner decision:** A first (smallest change), B/C only with the offline profile. Recommendation: A.

### 3.4 Cooling and review of newly published versions

- Existing precedent: Dependabot cooldown of 14 days for Actions ([`dependabot.yml:16-17`](../.github/dependabot.yml#L16-L17)).
  GitHub documents `cooldown` for docker, helm, maven and pip among others; it applies to **version** updates only and security
  updates bypass it; semver-specific cooldowns are not supported for docker/helm [S3].
- **Proposed:** extend the cooling rule from Actions to the other version-bearing surfaces by policy: no bump to `VERSIONS.md`,
  a Helm chart version, a lock entry or a Flink jar version within N days of upstream publication, unless it is a security fix
  with a recorded reason. N is an **Owner decision** (no official recommendation; the repository's only number is 14 days).
  Whether Dependabot can read the repository's chart `values.yaml`/`VERSIONS.md` image references must be tested; this document
  does not claim it can.

### 3.5 Egress restriction in CI

harden-runner offers an automatically created baseline that can be turned into a domain allow-list to block other outbound
traffic [S10]; the repository runs it in observation mode only.

- **Proposed:** step 1, keep `audit` and collect the endpoint set of each job (read the harden-runner insights per job); step 2,
  switch the `release.yml` jobs and `ci.yml` `validate` first to a blocking policy with that list (expected members include
  GitHub hosts, the PyPI hosts, the Helm/Trivy download hosts; the real list comes from step 1); step 3, remaining workflows.
- The release job must keep working when a re-run happens ([`RELEASING.md:28-34`](../RELEASING.md#L28-L34)); a blocked-endpoint
  failure must not look like a gate failure. **Owner decision:** blocking mode on `release.yml` only, or all workflows.
  Recommendation: release and validate first.
- Runtime pods: G7 requires default-deny egress per covered namespace; the pods in 3.3 still need PyPI today. Whether those egress
  rules exist and what they allow is **not verified in this document** and belongs in the implementation task.

### 3.6 Quarantine, rollback and the offline bundle

- **Proposed quarantine list:** a version-controlled file (for example `policies/quarantine.yaml`; design only) with artifact id,
  version or digest, reason, source (advisory or yank notice), date, issue. A checker fails if any entry matches an image
  reference, lock entry, chart version or pinned package in the repository. This gives "yanked/compromised version" a testable
  negative case.
- **Proposed rollback procedure** (documentation task): (1) add the entry to the quarantine list; (2) revert the bump commit
  (existing path, [`RELEASING.md:39-44`](../RELEASING.md#L39-L44)); (3) re-render, re-lock and re-run `make validate`; (4) if an
  affected release exists, record it in the release notes; (5) revoke or rotate credentials the compromised artifact could have
  read (it ran inside the cluster or the runner). Reproducibility is only as good as the pins: runtime pip installs (3.3) and
  tag-only images must be closed first, or the rollback target cannot be rebuilt identically.
- **Proposed offline bundle:** an "approved artifact set" directory = the lock file plus the artifacts it lists (manifests, chart
  archives, jars, installer, images exported by digest, Python wheels). A verification command checks every file against the lock
  with no network, in the style of the existing offline evidence verification ([`evidence_bundle.py:114-207`](../scripts/release/evidence_bundle.py#L114-L207)).
  K3s documents an air-gap path (images tarball, binary, installer, `INSTALL_K3S_SKIP_DOWNLOAD`) [S5]; Trivy documents running
  with pre-downloaded databases [S6]. The bundle's relation to the release evidence bundle is **additive**: evidence says what
  was released; the artifact bundle is what an offline install consumes. Scope for the first step: manifests, charts, jars and
  installer only; images are covered by the #10 proposal.

## 4. Verification and test ideas

| Test | Expected | Kind |
|---|---|---|
| Replace a pinned manifest, a chart `.tgz` and a jar with a same-named different file in a fixture | Each acquisition path exits non-zero and leaves no file | Offline fixture (extends the 8 existing cases) |
| Render charts with a jar hash edited | CI check fails before pod start | New static check on templates |
| Add a `curl | sh` line anywhere under `scripts/` or an unpinned `pip install` in a template | CI fails; allow-list has 0 entries after 3.1 | Existing check, extended scope |
| Quarantine entry that matches a rendered image or lock URL | CI fails naming the entry | New check, positive and negative fixtures |
| Job that contacts an unlisted host with blocking egress | Job fails; the blocked endpoint is reported | Runner test on a throwaway branch |
| Offline bundle verify with one byte changed, one file missing, one extra file | Each fails | Offline fixture |
| Digest drift: same tag, different digest between two renders | Fails (needs the #10 digest lock) | Cross-document |

## 5. Owner decisions remaining

| # | Decision | Recommendation |
|---|---|---|
| D1 | Remove the two installer allow-list entries by `fetch_verified` of tagged installers plus exact-version selectors | Yes, first implementation task |
| D2 | Signature verification of upstream artifacts: at bump time only, or in CI on every run | Bump time (manual), CI later |
| D3 | Runtime pip: option A, B or C of 3.3 | A now; B/C with the offline profile |
| D4 | Cooling period N for non-Actions version bumps | No official number; start from the existing 14 days |
| D5 | Egress blocking scope (release only, or all workflows) | Release and validate first |
| D6 | Whether `|| true` after verified applies stays for CNPG/Strimzi/Flink operator | Remove unless a written reason exists |
| D7 | Whether an offline install profile is in scope now, and who maintains the bundle | Decide with the #10 and environment-profile owners; do not start before D3 |
| D8 | Pin the CI beluga-manager SHA to one value in `ci.yml` and `release.yml` | Yes (already an open decision in `security-gates.md`) |

## 6. Follow-up implementation tasks (ordered, small)

1. Move the Flink jar hashes into the lock file and have both chart sites read them from one source. *Acceptance:* editing a hash
   in the lock changes both rendered scripts; `make validate` fails on a jar entry missing from the lock.
2. Extend `check-upstream-artifacts.py` to scan chart templates for `curl` downloads without a verification step and for unpinned
   `pip install`. *Acceptance:* the three current installs fail the check until fixed; fixtures cover pass and fail.
3. Replace the Helm installer with a hash-verified tarball and the k3s installer with a tagged, verified script; empty
   `UNVERIFIED_ALLOWLIST`. *Acceptance:* `check-upstream-artifacts.py` reports `0 allowlisted installer scripts`.
4. Pull the three Helm charts as archives and verify their hashes. *Acceptance:* a fixture with a swapped archive fails.
5. Hashed requirements files for Airflow, Superset and the clickstream generator (D3 = A). *Acceptance:* `pip install
   --require-hashes` succeeds in a clean container; removing a hash fails.
6. `policies/quarantine.yaml` plus checker and negative fixtures (section 3.6).
7. Rollback runbook section in `RELEASING.md` (bilingual).
8. harden-runner: collect baseline, then blocking policy for `release.yml` (D5). *Acceptance:* a job that curls an unlisted host
   fails on a throwaway branch.
9. Cooling policy text plus Dependabot ecosystem additions that a test PR proves work (D4).
10. Offline artifact bundle builder and verifier (D7).

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | Kubernetes, Images (digests are immutable; tags can be moved): https://kubernetes.io/docs/concepts/containers/images/ |
| S2 | pip, Secure installs (hash-checking mode, requirements must be pinned): https://pip.pypa.io/en/stable/topics/secure-installs/ |
| S3 | GitHub, Dependabot options reference (`cooldown`): https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference |
| S4 | Helm, Provenance and Integrity: https://helm.sh/docs/topics/provenance/ |
| S5 | K3s, Air-Gap Install: https://docs.k3s.io/installation/airgap |
| S6 | Trivy, Air-gapped environment: https://trivy.dev/latest/docs/advanced/air-gap/ |
| S7 | Sonatype, Maven Central publishing requirements: https://central.sonatype.org/publish/requirements/ |
| S8 | Argo CD, Verification of Argo CD signatures / signed release assets: https://argo-cd.readthedocs.io/en/stable/operator-manual/signed-release-assets/ |
| S9 | Strimzi, Deploying and managing (1.2.0 page searched; no signature/SBOM/cosign statement found): https://strimzi.io/docs/operators/latest/deploying.html |
| S10 | step-security/harden-runner README (baseline-derived domain allow-list for blocking egress; the audit/block definitions are on https://docs.stepsecurity.io/harden-runner, not read): https://github.com/step-security/harden-runner |

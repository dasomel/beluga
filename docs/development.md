# Development Guide

English | [한국어](development-ko.md)

Local development and contribution instructions. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for the contribution workflow and commit conventions; this document focuses on the
command surface and verification levels.

## Command surface

```text
make up         # boot the full cluster + GitOps bootstrap (bash scripts/up.sh)
make status     # VM and K8s pod status
make test       # tests/run-all.sh — real-state E2E verification (requires a live cluster)
make test-agent # tests/13-operations-agent-security.py — isolated agent policy/security
make lint       # shellcheck (scripts/, tests/, demo/) + helm lint
make validate   # static manifest/YAML validation — no cluster required
make down       # vagrant destroy -f
make clean      # remove .kube/ cache
```

## Verification levels

Distinguish three levels when reporting whether something works — see
[AGENTS.md](../AGENTS.md) for the evidence-first rule this backs:

1. **Static** (`make lint`, `make validate`, `make test-agent`) — shellcheck, `helm lint`,
   `helm template` render, YAML syntax, and isolated agent policy/security checks. Proves
   the manifests and policies are well-formed; proves nothing about runtime behavior.
   This is what CI runs on every PR and push
   ([.github/workflows/ci.yml](../.github/workflows/ci.yml),
   [.github/workflows/operations-agent-security.yml](../.github/workflows/operations-agent-security.yml)).
2. **Live E2E** (`make test`) — `tests/01-cluster-health.sh` through
   `tests/14-policy-compiler-seam.sh`
   query real cluster state (pod health, Kafka/CDC flow, Iceberg tables, Trino queries,
   Airflow DAGs, authz defaults, TLS/identity boundary). Requires a booted cluster;
   cannot run in GitHub Actions. The one exception is
   `tests/11-identity-plaintext-preflight.sh`: it renders the Helm charts with
   `helm template` and statically scans the output for plaintext identity endpoints, so
   it needs no live cluster and passes locally without one.
3. **Manual gateway/auth verification** — for auth and gateway changes, verify both
   direct component access and the documented user entry point (the APISIX gateway
   domain registry). See the 2026-08-25 `orch` entry in
   [docs/mistakes-log.md](mistakes-log.md) for why this distinction matters.

"Renders/lints successfully" and "actually works" are different claims. Do not conflate
them when reporting completion.

## Trivy HIGH ratchet (#117)

SAST pins Trivy 0.70.0. To reproduce its HIGH baseline locally, run the same Helm render
commands as `.github/workflows/sast.yml`, then scan the rendered directory and pass the
JSON report to the blocking ratchet:

```bash
set -euo pipefail
rendered="$(mktemp -d)/rendered"
mkdir -p "$rendered/beluga-platform" "$rendered/beluga-data-lite" "$rendered/beluga-data-full" "$rendered/plain"
helm template beluga-platform gitops/charts/beluga-platform --namespace platform-system --output-dir "$rendered"
helm template beluga-data gitops/charts/beluga-data --namespace storage --set openmetadata.enabled=false --set trino.workerEnabled=false --output-dir "$rendered/beluga-data-lite"
helm template beluga-data gitops/charts/beluga-data --namespace storage --set openmetadata.enabled=true --set trino.workerEnabled=true --output-dir "$rendered/beluga-data-full"
cp gitops/apps/*.yaml "$rendered/plain/"
trivy config --severity HIGH --format json --output /tmp/trivy-high.json "$rendered"
python3 scripts/ci/check-trivy-high-ratchet.py /tmp/trivy-high.json "$rendered"
```

The scan stays visible in CI and may report known debt. The following ratchet step blocks
new keys and stale baseline entries. The YAML records a reason for every resource/file
finding; the checker also freezes the baseline key digest so YAML-only growth cannot pass.

The offline dependency gate in `make validate` can also be run with
`python3 scripts/ci/check-dependency-integrity.py`. It requires exact pins and SHA-256
hashes in `requirements-ci.txt` and checks literal pip installation commands in
`.github/workflows/*.yml`, `Makefile`, `scripts/`, and `tests/`. Installations must use
`--require-hashes -r <local-file>`; referenced requirements receive the same validation.
Only quiet flags are additionally accepted. Exceptions require an exact path/command
and a reason in the checker; there are currently none. The supported syntax is
deliberately narrow (single lines or backslash continuations, including quoted commands).
Dynamic command construction is outside this static check. Temporary positive and
negative fixtures run every time, covering missing/malformed hashes, unpinned versions,
source substitution, missing hash enforcement, versioned pip executables
(`pip3.12`, `/usr/bin/pip3`), `python -m pip`/`-mpip` module invocation, `.yaml` (not
just `.yml`) workflow files, and shell redirection (`>`, `>>`, `2>&1`, `2>/dev/null`,
`| tee`) after a compliant install. This preserves CI's pip hash check; it does not
download artifacts, prove their provenance, or exercise Flink JAR checksums.

The upstream artifact gate (`python3 scripts/ci/check-upstream-artifacts.py`, Issue #103)
requires every manifest that `scripts/gitops/01-argocd-bootstrap.sh` downloads to pass
`fetch_verified` (`scripts/common/verified-fetch.sh`) against the SHA-256 pinned in
`configs/upstream-artifacts.sha256`. A missing, duplicate, malformed, or mismatching pin and
a failed download abort the bootstrap before `kubectl apply`. The gate rejects new
`kubectl apply -f <URL>` and `curl | sh|kubectl` in `scripts/`; the k3s and Helm installer
scripts are the only allowlisted exceptions (reason recorded in the checker). Negative
fixtures run against the real helper through `file://` URLs. When bumping an upstream
version, review the new file and replace the pinned hash together with the URL.
Pinned URLs must reference tags or commits; branch-like refs (`main`, `master`, `HEAD`,
`latest`, `stable`, `release-*`) are rejected. Known gaps the static scan does not detect:
`wget ... | sh`, URLs built from variables (`kubectl apply -f "${URL}"`), and
`helm repo add`/`helm install` from remote repositories (chart/image digest enforcement is
a later #103 step).

Known limitation: `-r <file>` arguments are always resolved relative to the repository
root, not to the working directory the invoking shell would actually use (e.g. a script
that `cd`s first, a Makefile recipe's directory, or a workflow step's
`working-directory:`). Every current call in this repository runs from the repository
root, so this does not produce false positives/negatives today, but a new call that
`cd`s elsewhere before using a relative `-r` path would not be checked correctly. Keep
new pip install calls rooted at the repository root, or update the checker's docstring
and this paragraph if that changes.

## License change gate (#26)

`make validate` runs the fixture self-checks in `scripts/ci/check-license-change.py`. To
compare against a baseline, pass `--base-ref <git-ref>` (read with `git show`) or
`--base-file <path>`. With no base, the checker skips comparison and says so. Exceptions
belong in `license_change_reviews` in `policies/license-policy.yaml`, with the exact
component, new license, reviewer, and rationale. `make validate LICENSE_BASE_REF=<git-ref>` forwards the base to the checker; the CI
`validate` job fetches full history and sets it to `origin/<base branch>` on pull requests
(push runs have no base and skip comparison). Generate deterministic release artifacts with
`python3 scripts/generate_release_license_inventory.py --out <directory>`; it writes
`release-license-inventory.md` and `release-license-inventory.json` from the canonical
version, notice, and policy files.

## Declared resource sizing report (#40, static slice)

`make validate` runs `tests/test_sizing_report.py` and `python3 scripts/generate_sizing_report.py --check`.
The report renders both charts with `helm template` (no cluster) twice: the base render (32GB profile) and
the render with `openmetadata.enabled=true trino.workerEnabled=true`, which `scripts/common/env.sh` turns on
for profiles at or above its threshold (48 and 64GB). The VM capacity per profile is parsed from `env.sh`
(master + the Vagrantfile's worker count x worker size). Print it with
`python3 scripts/generate_sizing_report.py [--json]`, or write `sizing-report.{md,json}` with `--out <directory>`
(sorted, no timestamps; nothing is committed, like the certificate inventory).

It reports, per profile: declared `resources.requests/limits` (cpu, memory) summed per workload and per
namespace (Deployment/StatefulSet x replicas, CNPG `Cluster`, `KafkaNodePool`, `FlinkDeployment`; Jobs and
CronJobs are listed but not summed), requests and limits as a percentage of raw declared VM capacity, and
workloads or containers missing requests/limits (including the Kafka CR, whose operator-managed pods declare
none). `--check` exits 1 when a profile's summed requests exceed its capacity or one pod's requests exceed a
single worker VM; missing requests/limits and limits above capacity are reported, never failed.

It does NOT report measured CPU/memory/storage/network usage, utilization or headroom targets, minimum/recommended/
production sizing, or cost. Those need a live cluster or an owner decision, and no targets or prices are
invented here. Capacity is raw VM size, not allocatable (OS/k3s/ArgoCD/system pods are not subtracted).
Flink pods are assumed to have request == limit (operator default) and one JobManager plus one TaskManager; treat the Flink share as a lower bound, because the real TaskManager count follows the job parallelism and slots, which the chart does not declare.

## Certificate inventory gate (#47)

`make validate` runs `scripts/ci/check-certificate-inventory.py`, including its
built-in positive and negative fixtures. To save the generated inventory:

```bash
python3 scripts/ci/check-certificate-inventory.py > /tmp/certificate-inventory.json
```

The checker renders both charts with `KUBECONFIG=/dev/null` for each RAM profile (32/48/64),
with OAuth listener both disabled and enabled, plus 32GB variants enabling
`listenerTls`, `externalListenerEnabled`, and `aclAuthorizer` separately. `openmetadata.enabled` / `trino.workerEnabled` use
the values that `scripts/gitops/01-argocd-bootstrap.sh` passes, so profile-only endpoints are checked too. Successful stdout is deterministic JSON containing every
Certificate's namespace, Secret, issuer, DNS/common name, requested lifetime,
renewal window and consuming resources. No certificate/key bytes are emitted.
The inventory is regenerated each run; there is no checked-in snapshot to drift.

The gate requires a unique cert-manager Certificate for each ApisixTls Secret,
Ingress TLS entry, terminating Gateway listener certificateRef, and workload TLS
Secret reference (ordinary/projected volumes, env and envFrom, including init
containers and embedded Pod specs). Issuers must exist in the combined render;
namespaced Issuers and Secrets must resolve in the correct namespace. Certificates
need DNS names or a common name, explicit positive `duration` and `renewBefore`,
and `renewBefore < duration`; declared endpoint hosts must be covered. Inline TLS
Secret data is forbidden, including recognizable certificate/key material hidden
in Opaque Secrets. Missing, duplicate, malformed and unsupported references fail.

Kafka listeners and the declared cluster/client CA ownership are listed separately.
TLS listeners using `brokerCertChainAndKey` are marked as externally supplied;
`generateCertificateAuthority: false` marks the relevant CA as externally supplied.
Otherwise, TLS listener certificates are classified as Strimzi cluster-CA signed.
For OAuth, each declared issuer, JWKS, introspection, or user-info URL must be HTTPS
without embedded credentials. Hostname verification cannot be disabled. Each
`tlsTrustedCertificates` reference must name `ca.crt` in a Secret managed by a
rendered Certificate. Its issuer must also issue a rendered Certificate covering
the URL host; the JSON records both references as consumers. This static issuer
and hostname comparison does not verify certificate bytes, the actual CA chain,
live expiry, Secret contents, or Keycloak reachability.

Unknown mounted/envFrom Secrets and unknown external env keys also fail. The
explicit `BOOTSTRAP_KEYS` list in `scripts/ci/certificate_endpoints.py` classifies
only the non-TLS credential keys created by `scripts/gitops/01-argocd-bootstrap.sh`;
TLS hints still require a Certificate. Review that list alongside bootstrap changes.
Gateway passthrough is rejected until route-to-backend certificate tracing exists.
Other controller-specific TLS sources need an explicit extractor and negative
fixtures before adoption; application code that fetches certificates dynamically
is outside this manifest gate.

The leaf schedules explicitly preserve cert-manager's 90-day lifetime and renewal
with one third remaining; the CA retains its existing one-year lifetime with the
same renewal fraction ([cert-manager documentation](https://cert-manager.io/docs/usage/certificate/)).
This is static evidence for #47's inventory and manifest-edit-free rotation
criteria, not closure of either production acceptance criterion. Production
profiles beyond this default render, operator-created certificates outside these
charts, actual expiry, renewal/reload, CA trust redistribution, expiry alerting and
invalid/expired-certificate behavior still need live evidence under #47.

### CI stages and Makefile parity

Every CI workflow check step maps to a documented `Makefile` target or is explicitly listed below as a non-make stage with an explanatory reason. This parity is statically enforced by `scripts/ci/check-ci-stage-parity.py` during `make validate`.

| Workflow | Step / Stage | Makefile target | Type / Reason |
|---|---|---|---|
| `.github/workflows/ci.yml` | `shellcheck + helm lint` | `lint` | Makefile target |
| `.github/workflows/ci.yml` | `helm template render + YAML syntax validation` | `validate` | Makefile target |
| `.github/workflows/research-evidence.yml` | `Set up Python` | *(none)* | Non-make: selects Python 3.12 for the validator |
| `.github/workflows/research-evidence.yml` | `Validate research evidence` | `research-check` | Makefile target |
| `.github/workflows/operations-agent-security.yml` | `Validate policy and fail-closed execution boundary` | `test-agent` | Makefile target |
| `.github/workflows/docs-check.yml` | `Verify bilingual pairs for root user-facing docs` | *(none)* | Non-make: inline shell verification of bilingual markdown pairs |
| `.github/workflows/docs-check.yml` | `Verify ADR pairs and index` | *(none)* | Non-make: inline shell verification of ADR index and pairing |
| `.github/workflows/sast.yml` | `Render Helm charts (every deployed values combination)` | *(none)* | Non-make: renders each chart+values combination gitops actually deploys via `helm template` before scanning (D21) |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — CRITICAL (blocking, rendered manifests)` | *(none)* | Non-make: runs Trivy IaC config scanner via aquasecurity/trivy-action |
| `.github/workflows/sast.yml` | `Trivy IaC misconfiguration scan — HIGH (non-blocking, visibility only, rendered manifests)` | *(none)* | Non-make: runs Trivy IaC config scanner via aquasecurity/trivy-action |
| `.github/workflows/sast.yml` | `Trivy HIGH debt ratchet (blocking)` | *(none)* | Non-make: checks rendered HIGH findings against the shrinking #117 baseline |
| `.github/workflows/sast.yml` | `Trivy secret scan (full repo)` | *(none)* | Non-make: runs Trivy secret scanner via aquasecurity/trivy-action |
| `.github/workflows/supply-chain.yml` | `Dependency update automation present` | *(none)* | Non-make: static file existence assertion for .github/dependabot.yml |
| `.github/workflows/supply-chain.yml` | `Version single source of truth present` | *(none)* | Non-make: static file existence assertion for VERSIONS.md |
| `.github/workflows/supply-chain.yml` | `No floating/missing image tags in Helm charts` | *(none)* | Non-make: inline shell scan for floating/missing tags against allowlist |
| `.github/workflows/supply-chain.yml` | `GitHub Actions are pinned to a commit SHA` | *(none)* | Non-make: inline shell verification of 40-char git commit SHA pins |
| `.github/workflows/release.yml` | `Validate release tag name` | *(none)* | Non-make: strict vMAJOR.MINOR.PATCH tag-name regex before anything else runs (injection guard) |
| `.github/workflows/release.yml` | `Verify tagged commit is on main` | *(none)* | Non-make: git ancestry check that the tag commit is reachable from main |
| `.github/workflows/release.yml` | `Verify vulnerability scan checks passed for tagged commit` | *(none)* | Non-make: requires the sast.yml Trivy check runs to have succeeded on the tagged commit (fail-closed) |
| `.github/workflows/release.yml` | `Resolve previous release tag for license gate` | *(none)* | Non-make: resolves the previous tag used as LICENSE_BASE_REF |
| `.github/workflows/release.yml` | `shellcheck + helm lint` | `lint` | Makefile target |
| `.github/workflows/release.yml` | `helm template render + YAML syntax validation` | `validate` | Makefile target |
| `.github/workflows/release.yml` | `Build release evidence bundle` | `release-evidence` | Makefile target |
| `.github/workflows/release.yml` | `Verify release evidence bundle offline` | `release-evidence-verify` | Makefile target |
| `.github/workflows/release.yml` | `Attest build provenance` | *(none)* | Non-make: actions/attest-build-provenance attests SHA256SUMS subjects to the commit/workflow run |
| `.github/workflows/release.yml` | `Verify provenance attestation` | *(none)* | Non-make: gh attestation verify of each published artifact |
| `.github/workflows/release.yml` | `Publish GitHub release` | *(none)* | Non-make: gh release create of the verified evidence files |

### Release evidence (#100)

Pushing a `vX.Y.Z` tag runs [release.yml](../.github/workflows/release.yml). The `gate` job fails
(and the `release` job never starts) unless the tagged commit is on `main`, the `trivy-config` and
`trivy-secrets` check runs succeeded for it, and `make lint` / `make validate` pass (license gate
against the previous tag included). The `release` job runs `make release-evidence`, which builds
`sbom.cdx.json` (CycloneDX 1.5: `VERSIONS.md` components and the images in the rendered charts —
it does not scan image contents; `scripts/generate-sbom.sh` against a live cluster remains the
transitive-package source), `release-license-inventory.{json,md}`, `platform-asset-inventory.{json,md}` (the declared-state asset inventory of #42, built with the same generator functions as `docs/platform-asset-inventory.md`, rendered by the CI-pinned Helm v3.16.4; it adds no owner, EOL/support-date or retention-period data, which need decisions and external data), verbatim copies of the repository's
`NOTICE` and `LICENSE`, `manifest.json` (version, commit) and `SHA256SUMS`; any license/SBOM failure aborts before a bundle exists. The files are attested
with GitHub build provenance (digest -> workflow run -> commit) and attached to the release.
`make validate` runs `tests/test_release_evidence.py` (tamper/missing/extra/forged-manifest/failing-gate
negative tests, including shipped NOTICE/LICENSE tampering) and a dry-run build+verify with a placeholder identity.

Offline verification of a downloaded release needs no network but does need a checkout of this
repository's `scripts/`: `python3 scripts/release/evidence_bundle.py verify <dir>`
checks checksums, the manifest/SBOM commit match, that no unlisted files exist, and that the shipped
`NOTICE`/`LICENSE` are byte-identical to the checkout's, the asset inventory has the expected shape, its Markdown is exactly the generator's rendering of its JSON, and that Markdown is byte-identical to the checkout's committed `docs/platform-asset-inventory.md` (verified against the committed document, not regenerated: regenerating needs Helm at the CI pin and other versions may render differently; a stale inventory fails), and the SBOM's `VERSIONS.md` component names equal the
checkout's `VERSIONS.md` rows — so run it from a checkout of the release tag (`--repo-root <dir>` points at another
checkout). This proves
bundle-internal consistency only: `SHA256SUMS` itself is not attested, so an attacker who can replace
the whole directory can replace it too (a self-consistent forged inventory with valid sums and shape also passes `verify` unless it differs from the checkout's committed `docs/platform-asset-inventory.md`; only provenance binds it to the release). Authenticity comes from provenance, checked with network:
`gh attestation verify <file> --repo dasomel/beluga --signer-workflow dasomel/beluga/.github/workflows/release.yml
--source-ref refs/tags/<tag>` for each of the `.json`/`.md` files, `NOTICE` and `LICENSE`. Not yet covered: image-digest
attestation against a live cluster, and signing of the tag itself.

## OpenForge status

[.github/workflows/openforge-status.yml](../.github/workflows/openforge-status.yml)
publishes `.openforge/status.json` (the `openforge-project-status/v1` payload) to the
`dasomel/openforge` portfolio after CI succeeds on `main`, or on manual
`workflow_dispatch`. It requires the repository secret `OPENFORGE_STATUS_TOKEN`
(a narrowly-scoped token able to open a PR in `dasomel/openforge`); when the secret
is absent the workflow validates `.openforge/status.json` and logs a skip message
instead of failing. `.openforge/status.json`'s `revision` and `evidence.commit` fields
must be the verified SHA that CI actually ran against, not a later or unverified commit.
The workflow enforces this: `revision` must be a verified commit reachable from the
run's SHA (an ancestor of, or equal to, the checked-out commit); the job fails otherwise.

## Environment

- `configs/cluster.env` — committed, non-secret cluster topology (subnets, node IPs,
  domain registry). Edit directly for topology changes.
- `.env.example` — sanitized template for the optional shell-environment overrides
  `scripts/common/env.sh` honors (RAM-profile overrides, `KUBECONFIG` path). Never add
  real secrets here or anywhere in the repo.
- This host runs many concurrent Kubernetes sessions. Always create an isolated
  kubeconfig before touching the `beluga` context — see [AGENTS.md](../AGENTS.md).

## Before you start

Read, in order: [AGENTS.md](../AGENTS.md) ->
[README.md](../README.md) -> [VERSIONS.md](../VERSIONS.md) ->
[docs/mistakes-log.md](mistakes-log.md) -> the relevant architecture/spec document under
`docs/superpowers/` -> the issue/spec you are implementing.

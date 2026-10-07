# External Network Dependencies

English | [한국어](external-dependencies-ko.md)

An inventory of the external hosts the repository's install, deploy and run-time code reaches, grouped by phase and derived only from this repository, plus a CI ratchet. It is a bounded static slice of [Issue #36](https://github.com/dasomel/beluga/issues/36) ("Define data residency and deployment-boundary controls").

> [!IMPORTANT]
> **Inventory fact, not approval.** A host listed here only means the repository's code reaches it in that phase. Inclusion is not an approval, not a restricted-profile allowlist, and says nothing about which data class may leave which boundary. Per-data-class residency, the restricted-profile allowlist content, preflight enforcement against a live cluster and remote-administration policy are open policy decisions of #36 and are NOT decided here. The disconnected-install profile remains the strongest boundary option and is not changed.

## Ratchet

`python3 scripts/ci/check-external-endpoints.py` runs in `make validate`. It extracts the (host, phase) set from the sources below and diffs it against the committed [`scripts/ci/external-endpoints-baseline.yaml`](../scripts/ci/external-endpoints-baseline.yaml) (host, phase, reason per entry; the baseline is the machine-readable list).

- A **new** (host, phase) not in the baseline **fails** CI. Adding it to the baseline with a reason is the escape hatch and is reviewed in the diff; it records an inventory fact, not an approval.
- A baseline entry no longer referenced **fails** as stale (same stance as `image-digest-baseline.yaml`): delete it, so the list only shrinks.
- A malformed baseline (not a mapping, unknown phase, duplicate, empty reason, bad host) fails closed, as does a render or scan that yields no images.
- Every baseline host must appear in backticks in this page and in the [Korean pair](external-dependencies-ko.md).
- Regression tests with negative fixtures: `tests/test_external_endpoints.py`.

`--report` prints the current phase, host and evidence rows.

### How false positives are avoided, and known limits

URLs are matched for `http(s)`, `ftp` and `ssh` schemes (optional `user@` userinfo is stripped so the real host is inventoried) plus `git@host:` clone forms. A configured source root (`scripts/`, `gitops/apps/`, `gitops/charts/`, `demo/`) that is missing or empty fails the gate explicitly. Extraction is line based and conservative: comment lines, trailing `#` comments and quoted `echo`/`printf`/`log_*` messages are ignored; internal hosts (no dot, `localhost`, IPs, `*.svc`, `*.cluster.local`, `*.beluga.internal`) and templated hosts (`${...}`, `{{ ... }}`, trailing dot) are skipped. Implicit endpoints without a literal URL use fixed rules: `pip install` / `uv pip install` map to `pypi.org` + `files.pythonhosted.org`, `apt-get install|update` to `apt-os-mirrors` (a reserved placeholder that is not a hostname and is the only dotless baseline entry the gate accepts; the real mirrors come from the OS apt sources), `config.vm.box` to `app.vagrantup.com`, a bare or namespaced image name to `docker.io`.

Known limits:

- A URL inside a heredoc or string that only documents a host can still match; a host built from variables is not visible.
- Hosts contacted by what the repo installs are **not derivable here**: the `get-helm-3` and `get.k3s.io` scripts' own downloads, and the images and downloads of the upstream manifests/charts (Argo CD, cert-manager, CloudNativePG, Strimzi, Cilium, MetalLB, Flink Kubernetes Operator, APISIX CRDs). Image registries are taken from images in the rendered charts only.
- pip and Maven pins are not checked here (see `check-dependency-integrity.py`); this gate lists hosts only.
- Telemetry, update checks and external integrations that exist only inside upstream images are not covered.
- Excluded on purpose: `.github/workflows/**` (CI-only, not a platform dependency), `scripts/**/*.py`, `scripts/ci`, `scripts/release`, `research/` (developer and CI tooling), docs and tests.

### Live-observed, not derivable from the repository

One live observation (2026-10-07, running cluster, Argo CD `quay.io/argoproj/argocd:v3.5.0`) found an image registry that the table below does not list: `public.ecr.aws`, serving `public.ecr.aws/docker/library/redis:8.2.3-alpine` (Argo CD redis, `argocd` namespace). It comes from the upstream Argo CD install manifest that `scripts/gitops/01-argocd-bootstrap.sh` applies, not from this repository's charts, so the extractor cannot see it and it is deliberately **not** in the machine-checked baseline (the ratchet derives from repository sources; an unreferenced entry would fail as stale). All other registries seen on that cluster (`docker.io`, `ghcr.io`, `quay.io`, `registry.k8s.io`) are already in the table, though several upstream-manifest images on them (Argo CD, Dex, Cilium, cert-manager, MetalLB, CloudNativePG, Strimzi, Flink operator) are likewise not derived here. This is an inventory fact from a single observation, not an approval or a policy, and the statement above that inclusion is not approval applies unchanged.

## Inventory by phase

### Host bootstrap and install scripts (`host-install`)

Source scanned: `Vagrantfile`, `Makefile`, `scripts/**/*.sh` except `scripts/gitops/`

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `app.vagrantup.com` | Vagrant box | `Vagrantfile:67` |
| `apt-os-mirrors` | OS packages (implicit placeholder, not a hostname) | `scripts/cluster/10-dnsmasq.sh:47`<br>`scripts/cluster/10-dnsmasq.sh:48` |
| `get.k3s.io` | Installer script | `scripts/cluster/02-k8s-init.sh:32`<br>`scripts/cluster/02-k8s-init.sh:61` |
| `helm.cilium.io` | Helm repo | `scripts/cluster/03-cni-metallb.sh:20` |
| `metallb.github.io` | Helm repo | `scripts/cluster/03-cni-metallb.sh:34` |
| `raw.githubusercontent.com` | GitHub raw (installer script) | `scripts/cluster/03-cni-metallb.sh:16` |

### Deploy bootstrap (GitHub raw/release downloads, Helm repos) (`deploy-bootstrap`)

Source scanned: `scripts/gitops/**/*.sh`

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `downloads.apache.org` | Helm repo | `scripts/gitops/01-argocd-bootstrap.sh:320` |
| `github.com` | GitHub release manifests | `scripts/gitops/01-argocd-bootstrap.sh:299`<br>`scripts/gitops/01-argocd-bootstrap.sh:313` |
| `raw.githubusercontent.com` | GitHub raw manifests | `scripts/gitops/01-argocd-bootstrap.sh:23`<br>`scripts/gitops/01-argocd-bootstrap.sh:306`<br>`scripts/gitops/01-argocd-bootstrap.sh:332` |

### GitOps sync (`gitops-sync`)

Source scanned: `gitops/apps/**`

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `github.com` | Git remote (Argo CD) | `gitops/apps/app-of-apps.yaml:11`<br>`gitops/apps/beluga-data.yaml:9`<br>`gitops/apps/beluga-platform.yaml:9` |

### Pod start / run time (Flink/Maven fetch, pip/PyPI) (`pod-runtime`)

Source scanned: `gitops/charts/**` (non-image URLs and pip installs)

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `files.pythonhosted.org` | PyPI files (implicit) | `gitops/charts/beluga-data/templates/07-airflow.yaml:161`<br>`gitops/charts/beluga-data/templates/08-superset.yaml:102`<br>`gitops/charts/beluga-data/templates/13-clickstream-gen.yaml:48` |
| `pypi.org` | PyPI index (implicit) | `gitops/charts/beluga-data/templates/07-airflow.yaml:161`<br>`gitops/charts/beluga-data/templates/08-superset.yaml:102`<br>`gitops/charts/beluga-data/templates/13-clickstream-gen.yaml:48` |
| `repo1.maven.org` | Maven artifacts (Flink) | `gitops/charts/beluga-data/templates/05-flink-operator.yaml:47`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:100`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:92`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:95`<br>`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:98` |

### Image registries (rendered charts) (`image-registry`)

Source scanned: `helm template` of both charts (3 combos from `check-image-tag-immutability.py`) and Airflow DAG `image=`

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `docker.io` | Image registry (implicit for bare names) | `beluga-data/files/dags/iceberg_maintenance.py:26` (trinodb/trino:483)<br>`beluga-data/templates/01-seaweedfs.yaml:67` (curlimages/curl:8.21.0)<br>`beluga-data/templates/05-flink-operator.yaml:8` (flink:1.20.0-scala_2.12-java17)<br>`beluga-data/templates/11-openmetadata.yaml:25` (opensearchproject/opensearch:2.18.0)<br>`beluga-data/templates/11-openmetadata.yaml:87` (openmetadata/server:1.13.3)<br>`beluga-data/templates/13-clickstream-gen.yaml:39` (python:3.12-slim)<br>`beluga-data/values.yaml:12` (chrislusf/seaweedfs:4.41)<br>`beluga-data/values.yaml:77` (apache/airflow:3.3.0-python3.11)<br>`beluga-data/values.yaml:82` (apache/superset:6.1.0)<br>`beluga-platform/templates/apisix-gateway.yaml:135` (apache/apisix:3.17.0-debian)<br>`beluga-platform/templates/apisix-gateway.yaml:400` (apache/apisix-ingress-controller:1.8.0)<br>`beluga-platform/templates/opa.yaml:51` (openpolicyagent/opa:1.19.0-static)<br>`beluga-platform/templates/openfga.yaml:41` (openfga/openfga:v1.18.3) |
| `ghcr.io` | Image registry | `beluga-data/templates/02-cnpg.yaml:8` (ghcr.io/cloudnative-pg/postgresql:17.6)<br>`beluga-platform/templates/openldap.yaml:131` (ghcr.io/dasomel/ldapium:nightly-4e85165) |
| `quay.io` | Image registry | `beluga-data/templates/03-strimzi-kafka.yaml:135` (quay.io/debezium/connect:3.6.1.Final)<br>`beluga-data/values.yaml:51` (quay.io/lakekeeper/catalog:v0.13.1)<br>`beluga-platform/templates/keycloak.yaml:304` (quay.io/keycloak/keycloak:26.7.1) |
| `registry.k8s.io` | Image registry | `beluga-platform/templates/apisix-infra.yaml:51` (registry.k8s.io/etcd:3.5.31-0) |

### Demo image build (not deployed by the charts) (`demo-build`)

Source scanned: `demo/**/Dockerfile*`

| Host | Kind | Evidence (file:line) |
|---|---|---|
| `docker.io` | Image registry (implicit) | `demo/clickstream-gen/Dockerfile:2` |
| `files.pythonhosted.org` | PyPI files (implicit) | `demo/clickstream-gen/Dockerfile:6` |
| `pypi.org` | PyPI index (implicit) | `demo/clickstream-gen/Dockerfile:6` |

Hosts are shared across phases: `raw.githubusercontent.com` and `github.com` serve both host bootstrap and deploy bootstrap; `github.com` is also the Argo CD sync remote; `pypi.org`, `files.pythonhosted.org` and `docker.io` also appear at pod run time or demo build time. Line numbers are as of the commit that last touched this page; the gate does not verify them (run `--report`).

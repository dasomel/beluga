# Authoritative Configuration Sources and Drift Boundaries

English | [한국어](configuration-sources-ko.md)

This document establishes the configuration baseline for the Beluga data platform, fulfilling Criterion 1 of [Issue #39](https://github.com/dasomel/beluga/issues/39) ("Authoritative configuration sources are documented"). Criteria 2–5 (material drift alerting, unauthorized vs expected drift classification, repeatable reconciliation runbooks, and retained drift audit records) remain open and are addressed in subsequent implementation passes.

---

## 1. Single Sources of Truth (Authoritative Configuration)

All deployable infrastructure, application parameters, images, and access control policies originate from declarative files tracked in Git. No manual or imperative mutation is authoritative.

| Domain | Authoritative File(s) | Description & Scope | Verification / Consumers |
|---|---|---|---|
| **Cluster & Network Sizing** | [`configs/cluster.env`](../configs/cluster.env) | Master/worker node IPs (`192.168.77.x`), RAM profile sizing (`BELUGA_PROFILE=64`), VM provider, MetalLB address pool (`192.168.77.200-220`), APISIX LB IP (`192.168.77.200`), and `*.local.beluga.internal` domain registry. | Sourced by `Vagrantfile`, `scripts/up.sh`, node provisioning scripts (`scripts/cluster/`), and `scripts/gitops/01-argocd-bootstrap.sh`. |
| **Component & Image Versions** | [`VERSIONS.md`](../VERSIONS.md) | Canonical versions, image tags (`repo:tag`), and software licenses for all 31 infrastructure, data platform, operator, and utility images. | Enforced by [`scripts/ci/check-version-consistency.py`](../scripts/ci/check-version-consistency.py) (fails if Helm template image tags drift from `VERSIONS.md`) and [`scripts/ci/check-license-policy.py`](../scripts/ci/check-license-policy.py). |
| **Platform Helm Values** | [`gitops/charts/beluga-platform/values.yaml`](../gitops/charts/beluga-platform/values.yaml) | Base domain (`local.beluga.internal`), APISIX load balancer IP, cert-manager enabled status/version, and Prometheus/Grafana ports. | Rendered by `helm template gitops/charts/beluga-platform`; managed by ArgoCD `beluga-platform`. |
| **Data Stack Helm Values** | [`gitops/charts/beluga-data/values.yaml`](../gitops/charts/beluga-data/values.yaml) | Base domain, SeaweedFS port/image, CNPG Postgres version/database names (`shop`, `beluga_meta`), Strimzi Kafka replicas/ports/auth flags, Lakekeeper port, Flink memory sizing, Trino heap/port, Airflow executor, and Superset port. | Rendered by `helm template gitops/charts/beluga-data`; managed by ArgoCD `beluga-data`. |
| **GitOps Applications** | [`gitops/apps/app-of-apps.yaml`](../gitops/apps/app-of-apps.yaml)<br>[`gitops/apps/beluga-platform.yaml`](../gitops/apps/beluga-platform.yaml)<br>[`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml) | ArgoCD Application definitions specifying Git repo URL, branch (`HEAD`), chart path, target destination namespaces, server-side apply, automated prune, and `selfHeal: true`. | Validated by [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py); bootstrapped by [`scripts/gitops/01-argocd-bootstrap.sh`](../scripts/gitops/01-argocd-bootstrap.sh). |
| **Declarative Access Policies** | [`policies/catalog.yaml`](../policies/catalog.yaml)<br>[`policies/groups.yaml`](../policies/groups.yaml)<br>[`policies/resources.yaml`](../policies/resources.yaml)<br>[`policies/roles.yaml`](../policies/roles.yaml) | Declarative definitions of data catalogs, user groups (`admins`, `engineers`, `analysts`), schemas/tables, and role permissions. | Syntax validated by [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py); compiled by external policy compiler into runtime artifacts. |

### Compiled Policy Outputs and Generation Seam

The declarative YAML in [`policies/`](../policies/) is never consumed directly by query engines or databases; instead, it is compiled into service-native formats by the companion repository **`dasomel/beluga-manager`** via its CLI compiler `policyctl` (`npm run policyctl -- compile policies --out <dir>`):

1. **Trino OPA Rego**: Compiled into [`gitops/charts/beluga-platform/files/opa/trino.rego`](../gitops/charts/beluga-platform/files/opa/trino.rego) (package `trino`). Enforces query authorization rules at the OPA sidecar.
2. **Keycloak Roles & LDAP Seam**: Compiled into `keycloak.json` (realm roles and group memberships). Checked against the LDAP schema and group CNs declared in [`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml).
3. **PostgreSQL Roles DDL**: Compiled into the **Generated Body** of [`gitops/charts/beluga-data/files/db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql) (between `-- BEGIN GENERATED BODY` and `-- END GENERATED BODY`). This body defines NOLOGIN roles (`admins`, `engineers`, `analysts`), role inheritance (`engineers` -> `admins`, `analysts` -> `engineers`), and explicit table/sequence `GRANT`s. The surrounding Prelude and Epilogue (LDAP login account `CREATE ROLE "beluga-analyst"` etc.) are hand-maintained.

The integrity of this compilation boundary is validated by [`tests/14-policy-compiler-seam.sh`](../tests/14-policy-compiler-seam.sh) in `make validate`.

---

## 2. Expected Runtime-Generated State (Deviations from Git)

Certain cluster state is dynamically generated at runtime or defaulted by Kubernetes controllers. This state is expected to differ from Git and must not be flagged as unauthorized drift:

### A. Bootstrap and Workload Credentials
- **Zero-Secret Invariant**: In accordance with [SECURITY.md](../SECURITY.md), no plaintext passwords or secret keys are committed to Git. Helm values defaults contain only placeholder strings (`SET-AT-BOOTSTRAP`).
- **Bootstrap Generation**: [`scripts/gitops/01-argocd-bootstrap.sh`](../scripts/gitops/01-argocd-bootstrap.sh) generates random 16-byte hex tokens via `openssl rand -hex 16` and populates the root `beluga-credentials` Secret in the `platform-system` namespace.
- **Derived Namespace Secrets**: `01-argocd-bootstrap.sh` projects credentials into workload namespaces as unmanaged Secrets (`postgres-admin-credential`, `keycloak-admin-credential`, `keycloak-db-credential`, `trino-keystore-password`, `ldap-admin-credential`, `ldap-reader-credential`, `trino-ldap-service-credential`, `keycloak-user-passwords`, `keycloak-client-secrets`, `superset-credential`, `apisix-admin-credential`, `trino-internal-shared-secret`, `seaweedfs-s3-credentials`). Workload charts reference these via `secretKeyRef`. Because these Secrets are created outside ArgoCD, ArgoCD's `selfHeal` does not attempt to prune or revert them.

### B. Operator-Generated Secrets and Certificates
- **cert-manager**: In [`gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml), [`gitops/charts/beluga-platform/templates/apisix-gateway.yaml`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml), [`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml), and [`gitops/charts/beluga-data/templates/06-trino.yaml`](../gitops/charts/beluga-data/templates/06-trino.yaml), `Certificate` custom resources trigger `cert-manager` to issue dynamic X.509 certificates and write TLS Secrets (`beluga-internal-ca-secret`, `apisix-gateway-tls-secret`, `openldap-tls-secret`, `trino-coordinator-tls-secret`). These Secret payloads (`tls.crt`, `tls.key`, `ca.crt`, `keystore.p12`) are generated at runtime by the PKI controller.
- **CloudNativePG (CNPG)**: In [`gitops/charts/beluga-data/templates/02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml), the `Cluster` resource `postgres-main` manages its own internal credentials and certificates. CNPG automatically generates and rotates operational Secrets (`postgres-main-app`, `postgres-main-superuser`, `postgres-main-ca`, `postgres-main-server`) at runtime.

### C. Kubernetes API Server Defaulting (Ignored Differences)
- **SeaweedFS StatefulSet `volumeClaimTemplates`**: The Kubernetes API server mutates `spec.volumeClaimTemplates` by injecting default fields (`apiVersion`, `kind`, `spec.volumeMode: Filesystem`, `status: {phase: Pending}`). Under ArgoCD Server-Side Apply (SSA), these API defaults previously produced permanent `OutOfSync` status and endless self-healing loops.
- **Explicit Exemption**: [`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml) declares `syncOptions: [- RespectIgnoreDifferences=true]` and filters these specific fields via `jqPathExpressions` under `ignoreDifferences`.

### D. Sync-Time Idempotent Mutation Jobs
ArgoCD sync hooks execute one-off mutating Jobs that configure downstream state using generated credentials:
- `db-roles-setup` ([`gitops/charts/beluga-data/templates/02c-db-roles.yaml`](../gitops/charts/beluga-data/templates/02c-db-roles.yaml)): Applies `db-roles.sql` to PostgreSQL upon each sync.
- `openldap-init` ([`gitops/charts/beluga-platform/templates/openldap.yaml`](../gitops/charts/beluga-platform/templates/openldap.yaml)): Seeds LDAP service accounts and groups.
- `keycloak-clients` & `keycloak-users` ([`gitops/charts/beluga-platform/templates/keycloak.yaml`](../gitops/charts/beluga-platform/templates/keycloak.yaml)): Reconciles client secrets and user passwords via Keycloak REST API.
- `superset-dashboard-import` ([`gitops/charts/beluga-data/templates/08-superset.yaml`](../gitops/charts/beluga-data/templates/08-superset.yaml)): Synchronizes data sources and dashboards.
- `flink-sql-submit` ([`gitops/charts/beluga-data/templates/05-flink.yaml`](../gitops/charts/beluga-data/templates/05-flink.yaml)): Checks running Flink jobs via REST API before submission to ensure idempotent re-execution without duplicate running pipelines ([`tests/13-flink-sql-idempotent.sh`](../tests/13-flink-sql-idempotent.sh)).

---

## 3. How Existing Checks Detect Drift Today

Beluga employs a two-tier drift detection model: static preflight validation (offline, run via `make validate` in CI) and live runtime reconciliation (continuous, enforced by ArgoCD).

### Tier 1: Static Preflight Drift Checks (`make validate`)

| Check | Script / Tool | What It Proves & Drift Detected |
|---|---|---|
| **Version Drift** | [`scripts/ci/check-version-consistency.py`](../scripts/ci/check-version-consistency.py) | Renders `beluga-platform` and `beluga-data` charts, then scans all image tags. Fails if any deployed container image differs from the canonical version pinned in [`VERSIONS.md`](../VERSIONS.md). |
| **Policy Compiler Seam Drift** | [`tests/14-policy-compiler-seam.sh`](../tests/14-policy-compiler-seam.sh) | (1) Validates YAML syntax of [`policies/*.yaml`](../policies/).<br>(2) Verifies package declarations in [`gitops/charts/beluga-platform/files/opa/trino.rego`](../gitops/charts/beluga-platform/files/opa/trino.rego).<br>(3) When the sibling `beluga-manager` checkout and npm are present, recompiles `policies/` with `policyctl` and asserts 0 diff against committed `trino.rego`; outside CI it only warns and skips this step if they are missing, while CI (`CI=true` / `REQUIRE_POLICY_SEAM_LIVE=1`) fails closed.<br>(4) Verifies Keycloak group and realm-role mappings against LDAP seed LDIFs and init scripts in `openldap.yaml`.<br>(5) Asserts byte-level 0 diff between compiled `roles.sql` and the Generated Body in [`gitops/charts/beluga-data/files/db-roles.sql`](../gitops/charts/beluga-data/files/db-roles.sql).<br>(6) Rejects forbidden SQL patterns (`REVOKE`, `ALTER DEFAULT PRIVILEGES`) in the generated body to preserve default-deny invariants.<br>(7) Executes negative self-tests verifying that tampered rules or SQL trigger hard test failures. |
| **YAML Syntax Integrity** | [`scripts/ci/validate-yaml.py`](../scripts/ci/validate-yaml.py) | Validates structural YAML syntax across `policies/` and `gitops/apps/`. |
| **License Compliance** | [`scripts/ci/check-license-policy.py`](../scripts/ci/check-license-policy.py) | Checks every component in `VERSIONS.md` against approved open-source license policies. |
| **Plaintext Identity Leakage** | [`tests/11-identity-plaintext-preflight.sh`](../tests/11-identity-plaintext-preflight.sh) | Renders all templates and ensures no plaintext identity endpoints (e.g., non-TLS Keycloak or LDAP URLs) exist in deployed configurations. |
| **TLS Certificate Inventory** | [`scripts/ci/check-certificate-inventory.py`](../scripts/ci/check-certificate-inventory.py) | Parses rendered Certificate resources to verify certificate durations, renewal windows, and DNS names. |
| **CI Parity & Dependencies** | [`scripts/ci/check-ci-stage-parity.py`](../scripts/ci/check-ci-stage-parity.py)<br>[`scripts/ci/check-dependency-integrity.py`](../scripts/ci/check-dependency-integrity.py) | Asserts Makefile targets, GitHub Actions workflow steps, and documented CI stages remain in parity, and verifies pinned package hashes. |
| **Flink DDL Idempotency** | [`tests/13-flink-sql-idempotent.sh`](../tests/13-flink-sql-idempotent.sh) | Ensures Flink SQL files use safe idempotent DDL and unique `pipeline.name` identifiers. |

### Tier 2: Live Cluster Reconciliation (ArgoCD `selfHeal`)

Live runtime drift is continuously detected and corrected by the ArgoCD GitOps engine:

1. **Automated Reconciliation**: Both [`gitops/apps/beluga-platform.yaml`](../gitops/apps/beluga-platform.yaml) and [`gitops/apps/beluga-data.yaml`](../gitops/apps/beluga-data.yaml) configure:
   ```yaml
   syncPolicy:
     automated:
       prune: true
       selfHeal: true
     syncOptions:
       - CreateNamespace=true
       - ServerSideApply=true
   ```
2. **Self-Healing Behavior**: ArgoCD monitors Kubernetes API resources against the desired state at git `targetRevision: HEAD`. Every Application in `gitops/apps/` sets `selfHeal: true`, so an out-of-band change to a field ArgoCD compares (for example an imperative `kubectl edit` of a managed spec) is expected to surface as `OutOfSync` and be reverted to Git on the next reconciliation. This is configuration, not verified behaviour: fields excluded via `ignoreDifferences` or defaulted by the API server are not compared, reconciliation is periodic rather than instantaneous, and no test in this repository exercises it (criterion 2 of issue #39 remains open).
3. **Pruning**: Any resource removed from the chart templates in Git is automatically pruned from the cluster (`prune: true`).

---

## 4. Issue #39 Acceptance Status

| Acceptance Criterion | Status | Implementation Evidence |
|---|---|---|
| **Criterion 1**: Authoritative configuration sources are documented. | **Complete** | Documented in this file ([`docs/configuration-sources.md`](configuration-sources.md) / [`docs/configuration-sources-ko.md`](configuration-sources-ko.md)). |
| **Criterion 2**: Material drift is detected and reported. | Pending | Open; planned in subsequent issue #39 passes. |
| **Criterion 3**: Unauthorized live changes can be distinguished from expected generated state. | Pending | Open; planned in subsequent issue #39 passes. |
| **Criterion 4**: Reconciliation procedure is repeatable. | Pending | Open; planned in subsequent issue #39 passes. |
| **Criterion 5**: Drift evidence is retained for operational review. | Pending | Open; planned in subsequent issue #39 passes. |

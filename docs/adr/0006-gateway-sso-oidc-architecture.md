# ADR-0006: Unified SSO/OIDC Architecture via Keycloak and APISIX Gateway

- Status: Accepted
- Date: 2026-10-16
- Supersedes: —
- Superseded by: —

Decision IDs: D-SSO-1 (Single declarative source), D-SSO-2 (Gateway OIDC & header sanitization), D-SSO-3 (Shared gateway client & idempotent creation), D-SSO-4 (ArgoCD native OIDC & group mapping).
Related branch: `feat/gateway-sso`.

## Context

The Beluga data platform exposes multiple web UIs and API services under a single domain registry (`*.local.beluga.internal`, unified HTTPS 443). However, authentication capabilities across the platform were fragmented:

1. **Lack of native authentication**: Apache Flink dashboard, SeaweedFS Filer UI, and Lakekeeper Web UI do not have built-in authentication/authorization mechanisms, leaving them vulnerable to unauthenticated or anonymous access.
2. **Need for REST API & probe bypass**: Lakekeeper (`catalog.local.beluga.internal`) serves both human-facing Web UI (`/*`) and machine/engine (Trino, Flink) Iceberg REST APIs (`/v1/*`, `/catalog/*`, `/management/*`, `/health`) on the same hostname. While the Web UI must enforce SSO, Lakekeeper REST endpoints (`/catalog`, `/management`, `/v1`) bypass gateway OIDC because Lakekeeper validates Keycloak bearer tokens natively via `LAKEKEEPER__OPENID_*` (`gitops/charts/beluga-data/templates/04-lakekeeper.yaml`).
3. **ArgoCD authentication consolidation**: ArgoCD GitOps control plane relied on initial local admin passwords and lacked integration with Keycloak LDAP SSO for role-based user separation.
4. **Scattered SSO configurations**: OIDC parameters (client IDs, redirect URIs, session cookies, bypass paths) were spread across chart templates or hardcoded, hindering systematic validation.

## Decision

### 1. D-SSO-1: Single Declarative SSO Source (`gitops/values/sso.yaml`)
Centralize all SSO/OIDC endpoint metadata in `gitops/values/sso.yaml`.
- Each endpoint declares its authentication `mode` (`gateway-oidc`, `app-oidc`, `none`).
- `gateway-oidc`: APISIX ingress gateway enforces the `openid-connect` plugin for UIs without native auth.
- `app-oidc`: Applications handle OIDC natively (integrated with Keycloak clients).
- `none`: No authentication enforced at gateway or application levels.
- Cost & Escape Hatch: Helm values must include `-f gitops/values/sso.yaml` during render. If authentication must be immediately bypassed, setting `mode: none` disables the gateway plugin rendering.

### 2. D-SSO-2: APISIX Gateway OIDC & Header Sanitization
Enforce the APISIX `openid-connect` plugin for services lacking native auth (Flink, SeaweedFS Filer, Lakekeeper Web UI).
- **OIDC Discovery TLS verification**: Mount the internal root CA (`beluga-internal-ca`) into APISIX via `ssl_trusted_certificate` and set `ssl_verify: true` to strictly validate Keycloak TLS certificates.
- **Header sanitization**: Use the APISIX `proxy-rewrite` plugin to strip sensitive OIDC headers (`X-Userinfo`, `X-Access-Token`, `X-ID-Token`) via `headers.remove` before requests reach upstream services, preventing spoofing and token leakage.
- **Route separation for Lakekeeper**: Split Lakekeeper into Web UI (`/*`, priority: 1) and REST API / health probes (priority: 10) to avoid 404s on OIDC callbacks (`/.apisix/redirect`, `/logout`) while allowing REST clients to authenticate directly with Keycloak bearer tokens (bypassing gateway OIDC).

### 3. D-SSO-3: Shared `apisix-gateway` Keycloak Client & Idempotent Creation
All endpoints protected by Gateway OIDC share a single Keycloak client: `apisix-gateway`.
- To handle already-bootstrapped clusters where the realm already exists (and realm JSON import is skipped), the `keycloak-clients` bootstrap job calls Keycloak REST API (`POST /admin/realms/{realm}/clients`) to idempotently create and reconcile `apisix-gateway` and `argocd` clients.
- Both clients are included in `TARGET_CLIENTS_FOR_SCOPES` to guarantee LDAP `groups`, `email`, and `profile` protocol mappers.

### 4. D-SSO-4: ArgoCD Native OIDC & Admin LDAP Group Mapping
ArgoCD integrates natively with Keycloak via `app-oidc`.
- Map the Keycloak `admins` LDAP group to ArgoCD `role:admin` (`g, admins, role:admin`).
- Inject OIDC issuer URL, client ID/secret, and internal root CA certificate (`rootCA`) into `argocd-cm` and `argocd-secret` for secure browser redirection and backend token exchange.

## Rollout Order & Prerequisites

Because GitOps applications (`beluga-platform`, `beluga-data`) operate with `selfHeal: true`, the rollout sequence must be strictly followed:
1. **Pre-create SSO secrets**: Run `scripts/gitops/01-argocd-bootstrap.sh --argocd-oidc-only` prior to applying GitOps changes.
   - This script creates `apisix-oidc-credential`, `keycloak-apisix-client-secret`, `keycloak-argocd-client-secret`, and patches `argocd-secret`.
   - Waits for `beluga-internal-ca` issuance (`kubectl wait --timeout=180s`), failing closed (exit 1) if not ready.
   - Passes all secret patches via stdin (`/dev/stdin`) to prevent plaintext exposure in argv.
2. **GitOps synchronization**: Synchronize `beluga-platform` and `beluga-data` including `sso.yaml` to deploy APISIX routes and reconcile Keycloak clients.
   - Note on rollout ordering: If the ArgoCD OIDC configuration is applied before the Keycloak `argocd` client exists, ArgoCD login fails until GitOps synchronization creates the client.
3. **Verification**: Run `tests/20-gateway-sso.sh` and `scripts/ci/check-gateway-sso.py` to verify redirects and lack of plaintext secrets.

## Consequences

- Flink dashboard, SeaweedFS Filer, and Lakekeeper Web UI are protected by Keycloak SSO.
- For Lakekeeper Web UI (`catalog-ui`), gateway OIDC protects static assets and HTML at the perimeter, while the SPA uses a public Keycloak client (`lakekeeper`) via PKCE to acquire bearer tokens for the Management API; the active Keycloak SSO session prevents double-prompting.
- Lakekeeper REST APIs and health probes continue functioning with native Keycloak bearer token authentication.
- ArgoCD supports individual logins and group-based admin RBAC via Keycloak LDAP.
- CI gate `check-gateway-sso.py` continuously verifies FQDN consistency, OIDC callback paths, absence of plaintext secrets, and CSP overlay coverage.

## Alternatives Considered

- **Per-pod OAuth2-Proxy sidecars**: Rejected due to container resource overhead and operational complexity compared to central APISIX ingress plugins (D-SSO-2).
- **Individual Keycloak clients per gateway service**: Rejected to minimize client secret management complexity; a shared `apisix-gateway` client (D-SSO-3) is sufficient and cleaner.

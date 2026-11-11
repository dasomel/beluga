# ADR-0010: Manager Lakekeeper read identity

English | [한국어](0010-manager-lakekeeper-read-identity-ko.md)

- Status: Accepted
- Date: 2026-11-12
- Owner: dasomel, issue #372 (owner decisions 2026-11-12)

## Context

Overview data assets were fixtures while the catalog adapter was disabled. ADR-0009
is already reserved by Manager SSO rollout references; use the next free number.
Follow [ADR-0008](0008-iceberg-maintenance-service-identity.md)'s dedicated credential
lifecycle without its LDAP/Trino privileges.

## Decisions

### D-MCAT-1: Dedicated service identity and credential

`manager-catalog-reader` is a confidential Keycloak service-account-only client.
Disable browser, implicit and password flows, full scope, default/optional scopes,
redirects and web origins. Dedicated mappers emit `preferred_username=svc-manager-catalog-reader`
and audience `lakekeeper`; Lakekeeper validates audience `lakekeeper` and uses
`preferred_username,sub`, hence the OpenFGA user is `oidc~svc-manager-catalog-reader`.
No LDAP user/group is needed. Realm import and `keycloak-clients` Sync reconciliation
share the contract; mapper subset comparison tolerates Keycloak-added defaults and
verifies applied targets. The private credential branch never prints secret values.

Bootstrap `ensure_cred client-secret-manager-catalog-reader` backfills fresh/existing
`platform-system/beluga-credentials`; copy only to `iam` and `platform-system` as
`keycloak-manager-catalog-reader-secret/manager-catalog-reader`. Never add it to shared
`keycloak-client-secrets`. Rotation: rerun authorized bootstrap, sync Keycloak, then
restart manager-domain-api (env Secret values are not dynamically updated).
Cost: one client and two dedicated copies. Escape hatch: retire together.

### D-MCAT-2: Warehouse describe only

The existing GitOps `lakekeeper-bootstrap` Job reads current assignments and writes
only a missing `describe` tuple on warehouse `lake`. Existing Trino/Flink assignments
stay unchanged; no select/create/modify/ownership/grant/admin role is added to Manager.
The [pinned v0.13.1 model documentation](https://github.com/lakekeeper/lakekeeper/blob/v0.13.1/docs/docs/authorization-openfga.md)
defines describe as inherited object listing/metadata permission, separate from select.
Manager's deployed names-only mode calls only GET `/catalog/v1/config?warehouse=lake`,
`/catalog/v1/{prefix}/namespaces` (including nested parents), and namespace `/tables`.
No table metadata load, storage credential delegation, data scan, or signer call is made.
Cost: all names in `lake` are visible. Escape hatch: disable the reader in both charts;
disabling wiring does not revoke the existing tuple: revoke it on an authorized retirement.
Unexpected inherited/out-of-band privileges must be investigated, never masked by a
successful describe grant; the live negative write test is required before rollout completion.

### D-MCAT-3: Private network wiring and profile toggle

`managerCatalogReader.enabled` defaults true in both charts because default/full/Kakao
profiles all include Manager, Keycloak and OpenFGA Lakekeeper. Disable it in BOTH releases
for profiles omitting these pieces or using allowall. Bootstrap Secrets before enabling.
Cross-namespace URLs use service FQDNs. `lakekeeper-ingress` allows only
`platform-system` AND `app=manager-domain-api` to TCP 8181. No egress policy selects
Manager today; preserve the network baseline and inventory Keycloak:8080 + Lakekeeper:8181
before introducing default-deny. Internal HTTP credentials explicitly opt in to the
existing cluster trust boundary. External issuer/gateway names still derive from baseDomain.
Cost: internal HTTP remains trusted. Escape hatch: reviewed internal TLS migration.

### D-MCAT-4: Bounded service token refresh

Domain-api exchanges client_credentials with scope openid, coalesces exchanges, caches
below expires_in, and reissues tokens without refresh_token. Redirects, oversized or
malformed responses and exchange errors fail closed; no expired-token or fixture fallback.
Exchange timeout is 1500ms; existing upstream and route budgets remain bounded.
Cost: Keycloak dependency. Escape hatch: externally rotated TOKEN_FILE, never admin credentials.

### D-MCAT-5 / D-MCAT-6: Shared names/counts, honest availability

Every authenticated Manager user can view the same asset names/counts without a group
gate (owner decision 2). Structural IDs, kinds, namespace/path and unknown status support
the existing API; columns, locations, properties, snapshots and credentials are omitted.
`kind=table/schema` without parentId traverses nested namespaces for accurate overview
totals. Bounded traversal/truncation fails rather than claiming an incomplete count.
Health lakekeeper=live describes wiring, not availability; fixtures=live requires the
catalog in addition to all existing overview sources. Catalog errors return 503 so the
existing UI shows unavailable. The UI calls only domain-api.
Cost: bounded traversal and five-second cache; escape hatch: an upstream aggregate API.

### D-MCAT-7: Staged enablement after the image pin

The platform chart ships `managerCatalogReader.enabled: false` in this change. The
Manager image pinned before it rejects the client-credentials environment at startup
(`BELUGA_LAKEKEEPER_ENABLED` without `TOKEN`/`TOKEN_FILE` is a config error), so enabling
it with the old pin would crash-loop domain-api. Identity, grant and NetworkPolicy deploy
now (harmless unused); the image pin-bump PR flips the flag to true. Cost: one extra PR.
Escape hatch: keep false and data assets stay stubbed.

## Verification and rollout

Offline: `python3 tests/test_manager_catalog_reader_render.py`, Manager verify/tests,
certificate/identity/network baseline checks. No live claims follow from rendering.
After authorized bootstrap, image build/publication and GitOps rollout, restart Manager
for changed env secrets; verify both Keycloak and Lakekeeper Jobs, token claims, refresh,
network reachability and UI unavailable behavior. The pinned Manager image is intentionally
unchanged here: orchestrator must publish this code and update VERSIONS/manifests together.

Run `MANAGER_LAKEKEEPER_LIVE=1 bash tests/30-manager-lakekeeper-assets.sh` with repo-local
kubeconfig. It uses analyst PKCE login at `manager.<baseDomain>`, validates live wiring,
compares Manager table/namespace counts against direct catalog listings, and expects 403
for a reader namespace create through the catalog gateway. It also probes the internal
catalog from the actual Manager pod, confirming the ingress exception. The negative
write should never succeed; if it does, the test fails and reports the unique namespace
for authorized cleanup. No automated destructive cleanup is attempted.

Remaining live evidence: fresh/existing realm reconciliation + secret rotation, actual
OpenFGA inherited permissions and denial, nested/paginated catalog parity, internal
network path, gateway TLS/PKCE, refreshed tokens across expiry, UI render/outage behavior.
Rollback: disable wiring in both charts/revert source; revocation and credential retirement
are separate authorized operations. Policies and generated OPA remain untouched.

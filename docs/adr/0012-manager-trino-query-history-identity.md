# ADR-0012: Manager Trino query-history identity

English | [한국어](0012-manager-trino-query-history-identity-ko.md)

- Status: Accepted
- Date: 2026-11-28
- Owner: dasomel (owner decision 2026-11-28: "own queries only")

## Context

The Manager query workspace showed "query history adapter not connected (503)" because the
chart never wired the Trino adapter (`BELUGA_TRINO_*`). The adapter calls Trino
`GET /v1/query` with one service credential and shows the result to every authenticated
Manager user (`BELUGA_TRINO_HISTORY_ACK=shared-service-credential`). Before this change it
accepted only a static `TOKEN`/`TOKEN_FILE`, so a Keycloak access token would expire.

Live check on 2026-11-28 (Trino 483 + generated OPA policy): `GET /v1/query` returned only the
caller's own queries. `beluga-admin` saw only its `SELECT 1`, `svc-maintenance` only its own, and a
principal without an LDAP entry (`service-account-flink`) got `200 []`. The generated
`trino.rego` has no `ViewQueryOwnedBy`/`FilterViewQueryOwnedBy` rule, so others' queries
are filtered out without any change to OPA.

## Decisions

### D-MQH-1: Dedicated service identity, own-queries view

`manager-query-history` is a confidential Keycloak service-account-only client with
the same shape as [ADR-0010](0010-manager-lakekeeper-read-identity.md) D-MCAT-1. Browser,
implicit and password flows, full scope, default and optional scopes, redirects and web origins
are disabled. Dedicated mappers emit `preferred_username=svc-manager-query-history` and audience
`trino`. There is no LDAP user, no group and no OPA grant, so the identity sees only its own
queries, which is in practice an empty list. Other users' SQL is never shown (owner decision).

Bootstrap `ensure_cred client-secret-manager-query-history` backfills
`platform-system/beluga-credentials` and copies only to `iam` and `platform-system` as
`keycloak-manager-query-history-secret/manager-query-history`. It is created even while
the chart toggle is off. It is never added to the shared `keycloak-client-secrets`. The
reconcile Job treats it as a private credential (no secret values in logs).
Rotation: rerun authorized bootstrap, sync Keycloak, then restart manager-domain-api.
Cost: one client and two dedicated copies. Escape hatch: retire them together.

### D-MQH-2: Verified TLS and in-process token refresh

domain-api gains `BELUGA_TRINO_TOKEN_ENDPOINT` + `_CLIENT_ID` + `_CLIENT_SECRET`, the same
client_credentials provider as D-MCAT-4 (bounded exchange, cached below expiry, fail closed).
These are mutually exclusive with `TOKEN`/`TOKEN_FILE`. Trino is called at
`https://trino.analytics.svc.cluster.local:8443`, verified against the internal CA that
`NODE_EXTRA_CA_CERTS` already mounts. The end user's token never reaches Trino. Literal
redaction (`BELUGA_TRINO_HISTORY_SQL=literals`) stays the default.
Cost: a Keycloak dependency for the history panel. Escape hatch: a rotated `TOKEN_FILE`.

### D-MQH-3: Toggle and rollout order

`managerQueryHistory.enabled` (beluga-platform) gates the realm client, the reconcile Job's
Secret reference and the Manager env. It defaults to false because the pinned Manager image
predates `BELUGA_TRINO_TOKEN_ENDPOINT`. That image would fail startup without a static token.
Enable it in the same change that bumps the Manager image pin to a build of this ADR's commit.
No NetworkPolicy change is needed: `analytics` has no ingress policy selecting the coordinator.
This was confirmed live from `platform-system`. Revisit it when `analytics` gets default-deny.
Cost: two-step rollout. Escape hatch: set false, and the panel returns to 503.

## Verification

- Static: `python3 tests/test_manager_query_history_render.py` (default/full/Kakao, both toggles),
  manager unit tests `packages/domain-api/tests/manager-query-history.test.ts`.
- Live (after the image bump): `GET /api/v1/query-history` returns 200 through
  `https://manager.<baseDomain>`, and the domain-api diagnostics include
  "Trino query history adapter enabled (read-only)".

## Known issue (separate)

During the live check Trino also accepted an access token whose audience was `lakekeeper`
(not `trino`). This is outside this ADR and is tracked separately. This identity still emits
audience `trino` explicitly.

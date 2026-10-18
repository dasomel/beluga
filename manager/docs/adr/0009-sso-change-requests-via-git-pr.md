# ADR-0009: SSO Change Requests via Git PR — Controlled Editing of the Declarative SSO Configuration

- **Status**: Proposed — design proposal; no write endpoint, GitHub integration, authorization code, audit store or gateway consumer of `allowedGroups` is implemented by this ADR.
- **Date**: 2026-10-17
- **Issue**: none recorded (*not verified*).
- **Related**: [ADR-0002](0002-backend-api-technology.md) (Domain API, Hono; D-MSSO-7 is an explicit exception to its OPA decision), [ADR-0006](0006-safe-actions.md) (Safe Actions, section 0 hard prerequisite), [ADR-0008](0008-gitops-argocd-integration.md) (read-only ArgoCD account), beluga root `docs/adr/0006-gateway-sso-oidc-architecture.md` (Gateway SSO/OIDC, repo root) (D-SSO-1..4; a different series from the manager ADR-0006), `AGENTS.md` (domain registry, independent review gate).
- **Deciders**: dasomel

Conventions: **Current state** lists observed facts (file/symbol or a command, evidence date 2026-10-17, beluga `main` at `76500d5`). Everything else is design intent. Numbers are *Proposed*. External facts carry an official URL or are marked *not verified*.

Decision IDs: Stage 2 code (merged in PR #283) already uses D-MSSO-1..5 (`config.ts`, `adapters/sso/ssoAdapter.ts`, `routes/sso.ts`, `schema/sso.ts`, `web/src/views/SsoView.tsx`). This ADR continues at **D-MSSO-6** (D-MSSO-14 is new in revision 2; D-MSSO-15..19 are new with rollout ④). `GET /api/v1/sso` is on `main` since PR #283.

## Context

`gitops/values/sso.yaml` is the single declarative SSO source (beluga D-SSO-1), consumed by both ArgoCD Applications (`valueFiles: ../../values/sso.yaml`), which run with `selfHeal: true`. Editing it by hand is the only way to change SSO today. The owner decided that the Manager may offer edits, **persisted as a Git pull request** (not a direct commit to `main`, not a cluster ConfigMap). A human merges; ArgoCD applies.

**Owner decision (2026-10-17)**: the only SSO setting editable from the Manager is **"groups allowed to access"** — a new per-endpoint field `allowedGroups` (array of Keycloak group names) on gateway-protected endpoints (mode `gateway-oidc`); the first iteration opens **`flink` and `filer` only** (D-MSSO-8). Editing is opened **only after APISIX actually consumes the field** (rollout step ②a). Design review (REVISE) found that the earlier editable field, `protectedPathPrefixes` of `app-oidc` endpoints, is read by no chart template, so editing it would change a file without changing behavior; that contract is removed.

### Current state (observed)

| Fact | Evidence |
|---|---|
| The Domain API has no authentication; `createApp` registers only CORS for `/api/*` with origin `http://localhost:5180`. | `manager/packages/domain-api/src/app.ts` (`createApp`, `cors(...)`). |
| Stage 2 (read-only `GET /api/v1/sso`) is merged (PR #283); there is no write route. The adapter reads a local file. | `manager/packages/domain-api/src/routes/sso.ts`, `adapters/sso/ssoAdapter.ts`; code comment D-MSSO-2 "Mutations (Stage 3) will be handled via GitOps pull requests". |
| No Manager Deployment, Application or route exists under `gitops/`. | `git grep -il "domain-api\|beluga-manager" -- gitops` returns nothing. |
| `sso.yaml` has no `allowedGroups` today. Endpoints: `flink`, `filer`, `catalog-ui` (`gateway-oidc`); `argocd`, `trino`, `superset`, `airflow`, `openmetadata` (`app-oidc`); `catalog-api`, `s3` (`none`). | `gitops/values/sso.yaml`. |
| Only the three `gateway-oidc` routes consume `protectedPathPrefixes`; no `app-oidc` template reads it. | `git grep -n protectedPathPrefixes -- gitops/charts scripts` hits only `gitops/charts/beluga-data/templates/10-apisix-route.yaml` (lines 14-16, 184, 281, 345). |
| Each `gateway-oidc` route uses `openid-connect` with `scope: "openid profile email"`, `set_userinfo_header: false`, and a `proxy-rewrite` that removes `X-Userinfo`, `X-Access-Token`, `X-ID-Token`. No group check exists. APISIX is 3.17.0. | `10-apisix-route.yaml` (lakekeeper-ui, filer, flink blocks); `VERSIONS.md` (APISIX row). |
| The `apisix-gateway` Keycloak client already has the `groups` client scope in `defaultClientScopes`. | `gitops/charts/beluga-platform/templates/keycloak-clients.yaml:273`. |
| Realm groups are `analysts`, `engineers`, `admins` (policy source) and are LDAP-backed in Keycloak. Test users: `beluga-admin` (admins), `beluga-engineer` (engineers), `beluga-analyst` (analysts). | `policies/groups.yaml`; `templates/keycloak-group-mapper.yaml`; `templates/keycloak-users.yaml` (`USERS`). |
| `scripts/ci/check-gateway-sso.py` renders the chart and audits that every `gateway-oidc` endpoint has an `openid-connect` route with sanitized headers; `tests/20-gateway-sso.sh` is the live check (login flow per endpoint). | `scripts/ci/check-gateway-sso.py` (docstring, `audit_gateway_routes`); `tests/20-gateway-sso.sh`. |
| OPA runs in namespace `iam` as Deployment `opa` with `replicas: 1`; policies come from ConfigMap `opa-policies` (`trino.rego`, `kafka.rego`) and a `checksum/policies` annotation rolls the Pod on any change. **No Manager policy package exists.** | `gitops/charts/beluga-platform/templates/opa.yaml` (`replicas` at line 30, `checksum/policies` at line 41). |
| The CNPG operator 1.30.0 is installed cluster-wide by the bootstrap script (manifest applied, rollout of `cnpg-controller-manager` in `cnpg-system` awaited). The existing cluster `postgres-main` (namespace `database`, `instances: 1`, `storage.size: 5Gi`) belongs to `beluga-data`. | `scripts/gitops/01-argocd-bootstrap.sh:482,515`; `VERSIONS.md` (CNPG row); `gitops/charts/beluga-data/templates/02-cnpg.yaml`. |
| Keycloak 26.7.1; realm import runs only on first boot, so clients on an existing cluster are reconciled by the Sync-hook Job `keycloak-clients` (namespace `iam`). | `VERSIONS.md`; `templates/keycloak-clients.yaml` header; beluga D-SSO-3. |
| `beluga-platform` deploys into `platform-system`/`iam`; `beluga-data` is a separate Application; both `selfHeal: true`. | `gitops/apps/beluga-platform.yaml`, `templates/00-namespaces.yaml`. |
| Merge requires an `independent-review` status on the PR head SHA; marking it required is the owner's call. | `AGENTS.md` (independent review gate). |

### External references (opened 2026-10-17)

- GitHub App installation token — <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>: "The installation access token will expire after 1 hour."
- GitHub App JWT — <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app>: expiry "must be no more than 10 minutes into the future".
- OPA REST API (for the D-MSSO-7 follow-up) — <https://www.openpolicyagent.org/docs/rest-api>: an undefined document returns HTTP 200 **without a `result` key**.
- GitHub contents API — <https://docs.github.com/en/rest/repos/contents>: updating a file requires `sha`, "the blob SHA of the file being replaced". The page does **not** state which status a stale `sha` returns (409 and 422 are both listed): *not verified*, so any 409/422 from the write call is treated as a conflict.
- Not opened, *not verified*, to be confirmed at implementation: Keycloak PKCE/client settings, realm JWT algorithm and JWKS path for 26.7.1; the `groups` claim name and whether group values are `admins` or `/admins`; GitHub git-refs/compare endpoints; GitHub rulesets (bypass list and ref targeting for `refs/heads/sso/*`); CNPG declarative roles and generated Secrets (<https://cloudnative-pg.io/documentation/1.30/> pages not opened); whether the CNPG operator watches `platform-system`.
- APISIX 3.17.0 plugin behavior used in D-MSSO-14 (`openid-connect` storing user info in `ctx.external_user` or the `X-Userinfo` header, `claim_schema`, `required_scopes`, `authz-keycloak`, `serverless-post-function` in the access phase) comes from the coordinator's investigation and is *not verified* here; **re-confirm against the 3.17.0 source before implementing**.

## Decision Drivers

1. ADR-0006 section 0 applies unchanged: no mutating route before token validation, per-action authorization, bearer-only credentials, confused-deputy handling, idempotency and audit.
2. Git stays the only way SSO state changes; the Manager never merges, never edits the cluster, never syncs.
3. The server, not the UI, enforces what may be edited; the SSO config is a security perimeter.
4. Fail closed: any doubt about identity, policy or audit means the write is refused.
5. A field is editable only if a running component consumes it and a test proves the effect.

## Considered Options

1. **Manager commits to `main` directly** — rejected: skips review and the independent-review gate.
2. **Manager patches a ConfigMap/Application in the cluster** — rejected: `selfHeal` silently reverts it (`docs/mistakes-log.md`, 2026-08-25 entry) and it bypasses Git.
3. **Personal access token (PAT) for the Git write** — rejected: the credential is attributed to an individual account and is a long-lived token (a fine-grained PAT can be limited to one repository, which is acknowledged); a GitHub App is an installation identity with 1-hour tokens.
4. **Gateway-session auth (APISIX) with forwarded identity headers instead of bearer JWT** — rejected for the write path: the Domain API cannot verify headers; beluga D-SSO-2 sanitizes them precisely because they are spoofable.
5. **Audit tables in the shared `postgres-main` (previous revision)** — rejected: the Manager (`beluga-platform`) would need a Secret and a `pg_hba` login from another Application's namespace, the role SQL would live next to the `policyctl`-generated block in `db-roles.sql`, and ArgoCD gives no ordering across Applications. Replaced by a dedicated cluster (D-MSSO-11).
6. **Authorization as an OPA policy in the first iteration** — deferred: any `opa-policies` change rolls the single OPA replica (`replicas: 1`, `checksum/policies`), which would interrupt Trino and Kafka authorization; needs `replicas >= 2` first (D-MSSO-7 escape hatch).
7. **Opening `protectedPathPrefixes` of `app-oidc` endpoints (previous revision)** — rejected: no template consumes it (Current state).
8. **Group check via APISIX built-ins** — `openid-connect` `claim_schema`: rejected (a failing claim answers 401, not 403, and an array "contains" check is not supported; *not verified*). `required_scopes`: rejected (scopes are not groups and do not fit the session/redirect flow). `authz-keycloak`: rejected (designed for token/UMA resource authorization, a poor fit for the browser session flow). Chosen: D-MSSO-14.
9. **SPA PKCE + bearer JWT, in-process authorization, GitHub App PR, dedicated CNPG audit (chosen)** — D-MSSO-6..14.

## Decision

### D-MSSO-6 Authentication — public PKCE client, bearer JWT (RS256)

- Keycloak realm `beluga` gets a new **public** client `beluga-manager` (Authorization Code + PKCE; redirect URI `https://manager.<baseDomain>/*`), created idempotently by extending the `keycloak-clients` Job as D-SSO-3 did for `apisix-gateway`. PKCE and client setting names are *not verified* against 26.7.1.
- The Domain API validates `Authorization: Bearer` on every `/api/v1/sso/change-requests*` route: signature via the realm JWKS (cached, internal CA trusted), **algorithm pinned to `RS256`** (anything else, including `none` and `HS*`, is rejected; that the realm signs with RS256 is *not verified*), `iss` exactly `https://sso.local.beluga.internal/realms/beluga` (from `sso.yaml`), `aud` containing `beluga-manager`, `exp`/`nbf` with small skew (*Proposed*: 30 s). Cookies are never accepted, so CSRF does not apply (ADR-0006 section 0, item 3).
- Unconfigured authentication means the routes answer 503, never open.

### D-MSSO-7 Authorization — in-process, deny by default (exception to ADR-0002)

- **First iteration**: the Domain API authorizes writes itself. A write (`preview`, `submit`) is allowed only if the **validated** JWT's `groups` claim contains `admins`; everything else is **403**. The group list comes only from the verified token, never from request bodies or headers. Unit tests cover: allowed, no `groups` claim, wrong type, empty, group-name variants (`admins` vs `/admins`, per the real token), and a tampered or expired token. Authorization is re-evaluated at submit, not only at preview.
- **Exception record**: ADR-0002 decision 3 delegates detailed authorization to OPA. This ADR deviates on purpose, for the first iteration only, because adding a Rego package rolls the single OPA replica (Considered Option 6).
- **Escape hatch (follow-up, not scheduled)**: move the check to OPA (`data.beluga.manager.sso.allow_write`, undefined or non-boolean result = deny, unreachable = 503) after OPA runs with `replicas >= 2` and the `opa.yaml` args/checksum roll is safe. The route-level contract (403/503) stays unchanged.

### D-MSSO-8 Edit contract — server-enforced, one field

The server computes the change from a **patch** (endpoint name plus the new `allowedGroups` list), never from a client-supplied document. It edits the YAML preserving comments and order (library chosen at implementation, *not verified*), re-parses the result, and answers **422** unless the **only** difference from the base file is `allowedGroups` of one of `flink`, `filer`.

| Endpoints | Editable | Locked |
|---|---|---|
| `flink`, `filer` (`gateway-oidc`) | `allowedGroups` | everything else: `name`, `host`, `mode`, `clientId`, `protectedPathPrefixes`, `bypassPathPrefixes`, `redirectPath`, `logoutPath` |
| `catalog-ui` (`gateway-oidc`) | nothing in the first iteration | all fields. `catalog-api` on the same host bypasses the gateway (mode `none`; Lakekeeper's own tokens and OpenFGA authorize), so restricting only the UI is weak protection. Open it only if the API path is also covered by a group-aware control (*future condition*). |
| `argocd`, `trino`, `superset`, `airflow`, `openmetadata` (`app-oidc`) | nothing | all fields |
| `catalog-api`, `s3` (`none`) | nothing | all fields |

Invariants (each rejected with 422 and a field-level message):
1. `allowedGroups` is non-empty, strings only, no duplicates.
2. Every entry exists in `policies/groups.yaml` (read from `main` with the same blob-SHA discipline as `sso.yaml`).
3. `admins` is always present (anti lock-out: the admins who edit must keep access).
4. No other field of any endpoint, and no other file, changes. The target path is the server constant `gitops/values/sso.yaml`; clients cannot choose it.
5. **Preview is a semantic comparison only**: it compares the `allowedGroups` set before and after; if the set is unchanged the preview answers **422** ("no effective change"). The Manager does **not** run helm; rendering and contract checks happen only in beluga CI (`check-gateway-sso.py`, D-MSSO-9).

The write routes answer 503 `CONSUMER_NOT_DEPLOYED` until an explicit configuration switch (default off) is turned on. The switch is turned on only after the live test of rollout step ②a has passed, not because a marker exists in chart values.

### D-MSSO-9 Concurrency, stale detection, idempotency

- **Stale rule (single definition)**: the preview returns `baseBlobSha`, the blob SHA of `gitops/values/sso.yaml` on `main` at preview time. At submit the server resolves current `main` HEAD, reads the blob SHA of that file at that commit, and answers **409 `STALE_BASE`** if it differs. Unrelated commits do not make a preview stale; HEAD equality is not checked.
- The branch is created from the **same commit SHA** whose blob was checked, and the file write passes that blob SHA as `sha`; any 409/422 from the write is a conflict (stage `failed`, 409 to the caller).
- **Current-state table `sso_change_requests`** (UPDATE allowed; separate from the append-only audit table of D-MSSO-11): one row per request with `id`, `stage`, `file_path`, `endpoint`, `idempotency_key`, `payload_sha256`, `branch`, `pr_number`, `updated_at`. A **partial unique index** on `(file_path) WHERE stage IN ('submitted','pr_open','unknown_recovering')` enforces **one active request per file**; the submit transaction also takes `pg_advisory_xact_lock` on a constant key before the check-and-insert. Concurrent submits therefore yield one PR; the loser gets **409 `OPEN_REQUEST_EXISTS`**.
- **Idempotency**: header `Idempotency-Key` = 32 lowercase hex characters (unique in `sso_change_requests`). The branch name is deterministic: `sso/<endpoint>-<first 12 characters of the key>`, e.g. key `3f9a1c7e5b2d4a8f9c0e1d2b3a4f5e6d` on `flink` gives `sso/flink-3f9a1c7e5b2d`. A replay with the same key and payload returns the existing record; same key with a different payload hash is **422 `IDEMPOTENCY_MISMATCH`**.
- **Re-validation at merge time (M2)**: the Manager's check is advisory because `main` can move between submit and merge. beluga CI therefore also enforces the contract on every PR that touches `sso.yaml`: `check-gateway-sso.py` is extended with the `allowedGroups` invariants (D-MSSO-8, items 1-3) and the helm render check. The owner turns on branch protection "require branches to be up to date before merging" (Open Owner Question 3), so a merge always follows a CI run against the current `main`.

### D-MSSO-10 Git write path — GitHub App

- A GitHub App installed on `dasomel/beluga` only, permissions Contents (write), Pull requests (write), Metadata (read). The Manager mints a JWT (max 10 minutes) and exchanges it for an installation token (1 hour) per use, cached in memory only (URLs above). The code path only creates `sso/*` branches and PRs, and has **no merge call**.
- **Key handling**: the owner creates the Secret (App ID, installation ID, private key) in `platform-system`; the key is mounted as a file by the kubelet (a `Role` for Secret `get` is **not** used, see D-MSSO-15) and never reaches the browser, logs or audit rows. The Secret is **added to the DR and Kakao redeploy checklists** (Secrets are not in Git; `csp/kakao-cloud` is the existing redeploy path).
- **Blast-radius limit**: a GitHub ruleset restricts the App's bypass and writes to `refs/heads/sso/*` so its credentials cannot push to `main` (ruleset capability *not verified*, see references); the server independently fixes the path to the constant `gitops/values/sso.yaml` and refuses any other.
- The PR body and the commit trailer record `Requested-by: <username> (<sub>)`, the reason (length-capped, rendered as escaped text), the diff and `baseBlobSha`; the App is the git author, the human is recorded. This is the **secondary** audit record.

### D-MSSO-11 Audit — dedicated CNPG cluster, append-only by grants, fail-closed

- **Store**: a small, Manager-only CNPG `Cluster` (*Proposed* name `manager-db`) in `beluga-platform`, namespace `platform-system`, `instances: 1`, a small PVC (*Proposed*: 1Gi). The CNPG operator already runs cluster-wide (Current state), so no new operator is needed; that it watches `platform-system` is *not verified*. The cluster's generated credentials Secret lives in the Manager's own namespace, which removes the cross-Application Secret and `pg_hba` problem and the dependence on `beluga-data`.
- **Tables**: `sso_change_event` (audit, append-only) and `sso_change_requests` (current state, D-MSSO-9). Migrations run as the owner role in a hook Job; the Manager runs as a different **writer role** with `INSERT`+`SELECT` (plus sequence `USAGE`) on `sso_change_event` and no `UPDATE`, `DELETE` or `TRUNCATE` there; it has `INSERT`/`SELECT`/`UPDATE` on `sso_change_requests` only. There is no hash chain. This stops the Manager itself from rewriting history; it does not stop database administrators, and the PR body is the independent second record. How the writer role and its password are declared in CNPG is *not verified*.
- **Rows** (`sso_change_event`): one row per stage transition, never updated: `request_id`, `stage`, `actor_sub`, `actor_username`, `endpoint`, `idempotency_key`, `base_blob_sha`, `payload_sha256`, `pr_number`, `pr_url`, `merge_commit_sha`, `reason`, `detail`, `created_at`.
- **Stage enumeration** = the state machine in D-MSSO-13 plus authorization outcome: `denied`, `previewed`, `submitted`, `pr_open`, `unknown_recovering`, `merged`, `applied`, `rejected`, `failed`.
- **Fail-closed**: the `previewed`/`submitted` row is written **before** any GitHub call. If the insert fails, the request is refused with **503 `AUDIT_UNAVAILABLE`** and nothing is sent to GitHub. Later transitions are retried in the background; their failure never alters Git state.
- **Startup**: the database is in the same Application, but a Pod can still start before it is ready. The Manager starts without the database: `GET` routes work, write routes answer 503 until a connection check passes, and readiness reports the audit store separately.

### D-MSSO-12 Deployment, read source and applied detection

- The Manager is deployed by `beluga-platform` (namespace `platform-system`) behind APISIX at the **new host `manager.<baseDomain>`** (today `manager.local.beluga.internal`). The domain registry in `AGENTS.md` does not list it, so rollout step ②b adds it to the registry and the `/etc/hosts` instructions. The localhost-only CORS in `app.ts` is replaced by an allow-list of that origin.
- **One read source in the cluster (M3)**: `GET /api/v1/sso` and the preview both use the same **GitHub read adapter** (blob of `gitops/values/sso.yaml` on `main` plus the commit SHA). The screen shows the **source commit SHA and refresh time**, so the viewer sees exactly what a preview is based on. The Stage 2 file adapter (D-MSSO-1) stays for **local development** and tests only; the adapter is selected by configuration, and an unconfigured cluster deployment does not fall back to the file adapter silently.
- **applied** = for **both** Applications `beluga-platform` and `beluga-data`, `status.sync.status` is `Synced` and `status.sync.revision` is the PR's `mergeCommitSha` **or a descendant of it** (GitHub compare, *not verified*). ArgoCD is read through the Kubernetes API (D-MSSO-16, criterion D-MSSO-17) because the account proposed in ADR-0008 is not implemented.
- **Limit**: an Application that is `OutOfSync` for an unrelated reason (or lagging) keeps the request at `merged` ("merged, awaiting apply") even if the change itself is live. The UI says so and links to the Application; the Manager does not try to attribute drift.
- Reverting is a manual revert PR following the normal review gate; a Manager "revert" action is out of scope.

### D-MSSO-13 Request lifecycle and UI

```mermaid
stateDiagram-v2
    [*] --> denied: authorization deny (403)
    [*] --> previewed: dryRun accepted
    previewed --> submitted: submit, base not stale
    submitted --> pr_open: branch + PR created
    submitted --> unknown_recovering: timeout during GitHub call
    unknown_recovering --> pr_open: branch and PR found
    unknown_recovering --> submitted: branch only, PR re-created
    unknown_recovering --> failed: nothing found
    submitted --> failed: GitHub or conflict error
    pr_open --> merged: PR merged by a human
    pr_open --> rejected: closed unmerged
    merged --> applied: ArgoCD criterion in D-MSSO-12
    applied --> [*]
    rejected --> [*]
    failed --> [*]
    denied --> [*]
```

- **Recovery**: from `unknown_recovering` the reconciler re-queries GitHub by the deterministic branch name. Branch and PR found: `pr_open`. **Branch only**: re-create the PR (idempotent by branch). Neither: `failed`. An **orphan PR** (PR exists, no matching record) is never adopted automatically; it is logged and reported to the admin view.
- **Lock release**: a request stuck in `pr_open` (for example a PR abandoned without closing) holds the single-active-request lock. Release is manual: an admin-only endpoint `POST /sso/change-requests/{id}/cancel`, or a documented SQL procedure on `sso_change_requests` by the owner role. Cancel **closes the open PR first**, then releases the lock and writes a `failed` audit row with the reason. If closing fails, the lock stays, the failure is recorded in the audit `detail`, and the call answers 502.
- `draft` exists only in the browser and is not audited. The Manager polls GitHub and ArgoCD (*Proposed*: every 30 s) rather than exposing a webhook. The SSO view shows the declared state of `main`; a pending request is a banner with its PR link and stage. The UI renders the server's edit contract and never decides what is allowed.

### D-MSSO-14 Enforcement of `allowedGroups` in APISIX (new, platform PR ②a)

- `sso.yaml` gains optional `allowedGroups: [<group>, ...]` on `gateway-oidc` endpoints. Only an **absent** field means **no group restriction** (today's behavior), so existing routes do not change until populated. An empty list is rejected by the schema and by `check-gateway-sso.py`, and the Manager never writes one (D-MSSO-8, invariant 1).
- In `gitops/charts/beluga-data/templates/10-apisix-route.yaml`, after `openid-connect` and before the upstream, a `serverless-post-function` (access phase, Lua) reads the groups from the user info that `openid-connect` stored after verifying the session, and answers **403** if none of them is in `allowedGroups`. Source: the `X-Userinfo` value set by `openid-connect` itself (needs `set_userinfo_header: true`); `ctx.external_user` is not set in 3.17.0. `proxy-rewrite` does **not** remove `X-Userinfo` on these routes (it runs in the rewrite phase, before the Lua); the Lua removes it right after the check. **A client-supplied `X-Userinfo` is never trusted**: confirmed against the 3.17.0 source (`openid-connect.lua`: `rewrite` clears the client's headers at its start and sets `X-Userinfo` only after authentication), and the render check asserts the phase and order.
- **Revocation delay (known limit)**: `openid-connect` caches the user info in the gateway session, so removing a user from a group takes effect only when the session expires or is re-established. Mitigations: (a) cap the gateway session lifetime (1 hour, set as `session.absolute_timeout: 3600` on routes with `allowedGroups`); (b) immediate block procedure: remove the user from the group at the source (LDAP), log the user out in the Keycloak admin console or Admin API (user session logout; endpoint *not verified*), then confirm the next request must re-authenticate. Whether a Keycloak logout invalidates the APISIX session cookie is *not verified*; the fallback is rotating `APISIX_OIDC_SESSION_SECRET` (invalidates all sessions; effect *not verified*). **Verification item for ②a**: confirm what the Lua check reads on every request (the session-cached user info vs a fresh lookup) and record it.
- The `groups` claim is present because the `apisix-gateway` client already carries the `groups` scope (Current state). To check against a real token: the claim name; the value format (`admins` vs `/admins`); whether `X-Userinfo` is base64-encoded JSON; and that the Keycloak groups mapper has `userinfo.token.claim` enabled (the user info, not only the access token, must carry `groups`).
- CI contract: `check-gateway-sso.py` asserts that every endpoint with `allowedGroups` renders the check with exactly those groups, after `openid-connect`, and that the Lua allow-table (which does contain the group literals) equals `allowedGroups`. **Live verification without fighting `selfHeal`**: the ②a PR commits real values to `gitops/values/sso.yaml` and ArgoCD applies them; no ad-hoc override is used (a manual `kubectl apply` would be reverted). **Decided (owner, 2026-10-17)**: committed values are `allowedGroups: [admins, engineers]` on both `flink` and `filer`; `catalog-ui` stays locked with no field (no group check, today's behavior). `tests/20-gateway-sso.sh` asserts `beluga-admin` 200 / `beluga-engineer` 200 / `beluga-analyst` 403 on `flink`, and `beluga-engineer` 200 / `beluga-analyst` 403 on `filer` (403 body must carry `Forbidden: group not allowed`, so a 403 from another layer cannot pass). The 403 proof relies on `analysts` being outside the list, so engineers keep Flink UI access. Implemented: `serverless-post-function` (access phase) via the Helm helper `beluga.ssoGroupGuard`; routes with `allowedGroups` set `set_userinfo_header: true`, `session.absolute_timeout: 3600` (the 1-hour cap; the key exists in the 3.17.0 schema) and drop `X-Userinfo` from `proxy-rewrite` (rewrite phase runs before the Lua). Verified against the 3.17.0 source: `openid-connect` clears the client's `X-Userinfo` at the start of `rewrite` and sets it to base64(JSON userinfo) after session authentication; `ctx.external_user` is not set, so the header is the source. The Lua normalizes `admins` / `/admins`, fails closed (403) on a missing header, bad base64/JSON or missing `groups`, and removes `X-Userinfo` itself. The Keycloak groups mapper already has `full.path: false` and `userinfo.token.claim: true`. What the check reads per request is the session-cached userinfo (no fresh lookup), hence the revocation delay above. Live status of these facts is recorded by the ②a live run, not here.
- Escape hatch: removing `allowedGroups` (or `mode: none`) removes the check. Cost: Lua in the gateway config, one more thing to keep compatible on APISIX upgrades.

### D-MSSO-15 GitHub App credentials as a kubelet-mounted Secret (rollout ④)

- Secret `manager-github-app` in `platform-system`, created by the owner and never in Git, keys `app-id`, `installation-id`, `private-key.pem`. `domain-api` reads `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` through optional `secretKeyRef`s and the key from the file `GITHUB_APP_PRIVATE_KEY_FILE=/var/run/secrets/github-app/private-key.pem` (Secret volume, `items` only `private-key.pem`, `defaultMode: 0440`, `optional: true`; see D-MSSO-15a). The writer is wired only when both ids are digits **and** the key file is readable; otherwise it is `undefined` and submit/cancel answer `503 GIT_WRITER_UNCONFIGURED` exactly as in rollout ③, with no reconciler. One log line says "unconfigured" without values.
- The JWT is RS256 via `node:crypto` (no new dependency): `iat = now-60`, `exp = now+540`, `iss = app id`. The installation token (`POST /app/installations/{id}/access_tokens`) is cached in memory until 5 minutes before `expires_at`. Key, JWT and token are never logged or returned.
- **Deviation from D-MSSO-10**: D-MSSO-10 asked for a `Role` allowing `get` on the Secret. The kubelet mounts the key, so the Pod needs **no Kubernetes API permission on Secrets**; no such Role exists, and `check-manager-github.py` fails if any `Role` in `platform-system` grants Secret access. *Cost*: key rotation reaches the Pod on the kubelet sync period (about a minute); the optional Secret means a missing Secret silently disables the writer (visible as `gitWriterConfigured: false` and in health). *Escape hatch*: delete the Secret and restart, or set `SSO_WRITE_ENABLED` to `false`; the writer is gone and reads continue.

**D-MSSO-15a Key file mode 0440.** The first draft used `0400`; the file is then owned by root and only readable by uid 1000 if the kubelet happens to add the fsGroup read bit. The key volume now uses `0440` with the pod's `fsGroup: 1000`, exactly the pattern of the `manager-db-password` volume that is proven live in rollout ③; `scripts/ci/check-manager-github.py` asserts mode `0440` and `fsGroup`/`runAsUser` `1000` (and self-tests that `0400` and a missing `fsGroup` fail). *Cost*: the group (gid 1000, only the Manager container) can read the key, which is the same exposure as the DB password. *Escape hatch*: none needed; revert to `0400` only together with a verified kubelet behavior.

### D-MSSO-16 ArgoCD read through the Kubernetes API (rollout ④)

- ADR-0008's read-only ArgoCD account is not implemented, so `applied` detection reads the two `Application` objects from the Kubernetes API. ServiceAccount `manager-domain-api` (`platform-system`, `automountServiceAccountToken: false`); `Role manager-argocd-app-reader` in namespace `argocd`: `argoproj.io` `applications`, verbs **`[get]`**, `resourceNames` **`[beluga-platform, beluga-data]`**; a `RoleBinding` to that ServiceAccount. No `list`, `watch` or wildcard, and no other Application is readable.
- The Pod keeps `automountServiceAccountToken: false` and instead mounts a projected volume at `/var/run/secrets/kube-api` (`serviceAccountToken`, `expirationSeconds: 3600`, path `token`, plus `kube-root-ca.crt` key `ca.crt`). Env: `KUBE_API_TOKEN_FILE`, `KUBE_API_CA_FILE`, `KUBE_API_URL=https://kubernetes.default.svc`. The code re-reads the token file on every call (the kubelet rotates it). Missing files leave the reader `undefined`; requests then stay `merged`.
- Network: the `argocd` NetworkPolicies select ArgoCD pods and do not affect calls to the API server; `platform-system` has no default-deny, so `kubernetes.default.svc` and `api.github.com:443` need no allow rule (revisit together with the existing note in `manager.yaml` if a default-deny is introduced).
- *Cost*: RBAC objects in `argocd` are now owned by `beluga-platform`, and `argocd` appears in the security-baseline inventory as a referenced (not workload) namespace. *Escape hatch*: remove the `Role`/`RoleBinding`; requests stop at `merged`. When ADR-0008 lands, switch the reader and drop this Role.

### D-MSSO-17 `applied` criterion

For **both** Applications, `status.sync.status == "Synced"` **and** `status.sync.revision` R satisfies GitHub compare `GET /repos/{owner}/{repo}/compare/{mergeCommitSha}...{R}` with `status` in `identical` or `ahead`. Anything else (`OutOfSync`, API error, `diverged`, `behind`) leaves the request at `merged`. This pins down the "descendant of the merge commit" wording of D-MSSO-12.

### D-MSSO-18 Reconciler

An in-process interval (`SSO_RECONCILE_INTERVAL_MS`, default 30000, minimum 5000; the chart does not set it), single-flight (a tick never overlaps), started only when the audit store **and** the writer are configured, stopped on shutdown. Every transition is a compare-and-set (`UPDATE ... WHERE id = $1 AND stage = $expected`), so a second replica or a racing cancel cannot double-transition and a lost CAS is a no-op.

- `submitted` older than 120 s (process died mid-call) and `unknown_recovering`: look up the branch and PR by the deterministic branch (only a PR created no earlier than the request minus 5 min counts, D-MSSO-19a). PR found: `pr_open`. Branch only: re-run the idempotent `createChangePr` (D-MSSO-19); an `unknown_recovering` row first takes the audited hop `unknown_recovering -> submitted` and then `-> pr_open` (D-MSSO-18e). Neither: `failed` with detail `{reason: "not found on GitHub"}`.
- `pr_open`: merged becomes `merged` (with `merge_commit_sha`); closed unmerged becomes `rejected`. `merged`: D-MSSO-17 true becomes `applied`.
- Orphan open `sso/*` PRs without a record are logged once per PR number and never adopted. GitHub errors are logged and retried on the next tick; they change no stage except by the rules above.
- *Cost*: with `replicas: 1` the poll lag is up to one interval. *Escape hatch*: unset the writer Secret (D-MSSO-15) to stop the loop.

Review additions (all keep the compare-and-set rule above):

- **D-MSSO-18b Cross-replica lease.** A tick runs only while it holds the session advisory lock `pg_try_advisory_lock(8240170002)` on a dedicated pooled connection; it is released in `finally`, a crashed replica loses it with its connection, and a tick that cannot get it is skipped. *Cost*: one pooled connection (pool max 4) for the length of a tick. *Escape hatch*: terminate the holding backend; the lock key is a literal visible in `pg_locks`.
- **D-MSSO-18c Orphan-PR compensation.** When the submit route or the reconciler created or found a PR but its `pr_open` compare-and-set loses and the row is already `failed` or `rejected` (cancelled meanwhile), the PR would be open and untracked. It is closed best effort and an audit event with the row's current stage and detail `{compensation: "closed_orphan_pr", prNumber}` is recorded (`close_orphan_pr_failed` plus a log line when the close fails; the submit then answers `409 REQUEST_NOT_ACTIVE`). *Cost*: one GitHub call and one audit row in a rare race. *Escape hatch*: close the PR by hand.
- **D-MSSO-18d Graceful shutdown.** On SIGTERM/SIGINT the timer stops and the process waits at most 10 s for the tick in flight before exiting; anything left is recovered by the next tick (here or on another replica).
- **D-MSSO-18e Recovery hops.** The branch-only recovery path records the ADR state diagram: `unknown_recovering -> submitted -> pr_open`, two audited compare-and-set transitions. The writer input is rebuilt before the first hop, so a request that cannot be rebuilt keeps its stage.
- **D-MSSO-18f Cancel vs in-flight submit.** Cancelling a `submitted` row whose `updated_at` is younger than 120 s answers `409 REQUEST_IN_FLIGHT` (the submit route may still be creating the PR); compensation (18c) covers the rest. *Cost*: an admin may wait up to 120 s to cancel a request that really is stuck.
- **D-MSSO-18g Cancel audit order (D-MSSO-11, fail-closed).** Before any GitHub call, cancel inserts an event with the row's current stage and detail `{cancel: "requested", by: <sub>}`. If that insert fails the answer is `503 AUDIT_UNAVAILABLE` and GitHub is never called. *Cost*: one more audit row per cancel.

### D-MSSO-19 Idempotent `createChangePr`

Create the ref (422 "Reference already exists": read the ref, continue if the branch exists); `PUT` the contents on the branch with `sha` = the blob on the branch (`baseBlobSha` on the first write; if the branch file already equals the target, skip the write); open the PR `head=<branch>` `base=main` (422 "A pull request already exists": look it up by `<owner>:<branch>` and return it). `409`/`422` on the content write is a `GitWriteError` conflict; `401`/`403`/`404` is `rejected`; timeout, `5xx` and network errors are `unknown`. Commit message: `chore(sso): <endpoint> allowedGroups via Manager`, a blank line, then `Requested-by: <username> (<sub>)`. The PR body carries requester, reason (rendered inside a fenced code block after stripping backticks), `baseBlobSha`, `sourceCommitSha` and the diff in a `diff` block. The writer refuses any branch not matching `^sso/(flink|filer)-[0-9a-f]{12}$` and any path other than `gitops/values/sso.yaml`, and has **no merge call**.

- **D-MSSO-19a Branch/PR adoption is bounded.** The branch is derived from the first 12 hex characters of the key, so two keys can name the same branch. `store.submit` (under the existing advisory lock) rejects a new key whose branch already belongs to any row with `409 IDEMPOTENCY_KEY_COLLISION` (the client retries with a new key; the web UI regenerates it). Recovery and cancel only adopt a PR found by branch when its `created_at` is not earlier than the request's `createdAt` minus 5 minutes. *Cost*: a 1-in-2^48 collision per pair costs one retry; a PR with an unreadable `created_at` is never adopted. *Escape hatch*: close or adopt by hand.
- **D-MSSO-19b Overall deadline.** One `createChangePr` (all calls, the 401 retry and token refresh) has a 60 s budget (`CREATE_PR_DEADLINE_MS`), below the 120 s grace of `submitted` rows; exceeding it is a `GitWriteError` of kind `unknown`, so the request becomes `unknown_recovering` and is recovered.
- **D-MSSO-19c Pagination.** The orphan scan (`listOpenSsoPrs`) follows `Link: rel="next"` up to 5 pages of 100; the next URL is built by the client, never taken from the header.
- **D-MSSO-19d Race-safe content write.** On `409`/`422` from the content `PUT`, the branch file is read again; if it equals the target content (another instance wrote the same change) the flow continues to the PR step, otherwise it is a conflict.

## API

New routes, all under `/api/v1` (Stage 2's `GET /api/v1/sso` is the read side):

| Route | Purpose | Notable errors |
|---|---|---|
| `POST /sso/change-requests?dryRun=true` | validate the patch, return diff and `baseBlobSha` (semantic comparison, no helm); writes an audit row | 400, 401, 403, 422, 503 |
| `POST /sso/change-requests` (`Idempotency-Key`) | create branch and PR; returns the record | 401, 403, 409 `STALE_BASE`/`OPEN_REQUEST_EXISTS`, 422, 502, 503 |
| `GET /sso/change-requests/{id}` | current stage of one request | 401, 403, 404 |
| `POST /sso/change-requests/{id}/cancel` | admin: close the open PR and release the lock (D-MSSO-13) | 401, 403, 404, 409, 502 |

Status codes: 401 invalid token; 403 not in `admins`; 503 audit unavailable, authentication unconfigured or consumer not deployed; 502 GitHub failure after the audit row exists.

```json
{
  "id": "0b6f6f0e-2a3c-4a53-9f1d-0d0c2f4e9a11",
  "stage": "pr_open",
  "endpoint": "flink",
  "patch": { "allowedGroups": ["admins", "engineers"] },
  "baseBlobSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceCommitSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "branch": "sso/flink-3f9a1c7e5b2d",
  "pr": { "number": 0, "url": "https://github.com/dasomel/beluga/pull/0" },
  "mergeCommitSha": null,
  "diff": "--- a/gitops/values/sso.yaml\n+++ b/gitops/values/sso.yaml\n..."
}
```

(Placeholder values, not real SHAs or PR numbers.)

## Consequences

### Positive
- The only editable setting has a real, tested effect at the gateway, and access narrowing goes through review, the independent-review gate and ArgoCD.
- No cluster write credentials in the Manager; authorization and audit have no cross-Application dependency.
- The edit contract lives in one place on the server and is re-checked in CI at merge time.

### Negative
- New platform work: gateway consumer (Lua), Keycloak client, dedicated CNPG cluster, Manager deployment, a new host, a GitHub App and its Secret/Role/ruleset.
- Authorization is in-process, diverging from ADR-0002 until the OPA follow-up.
- Writes are unavailable whenever the audit database or GitHub is down (intended).
- The contract is deliberately narrow; opening more fields is a separate decision under Driver 5.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Lua check misreads groups and locks everyone out | `admins` forced into every list; absent list = no restriction; live 200/403 test (tests/20); manual revert PR as recovery. |
| Group removal not effective until the gateway session expires | Session lifetime cap (*Proposed*: 1 h) and the immediate block procedure in D-MSSO-14. |
| Forged `X-Userinfo` from a client | Never trusted: function runs after `openid-connect` overwrites it; CI asserts order (D-MSSO-14). |
| App private key theft | Narrow repo and permissions, ruleset limiting writes to `sso/*`, constant file path, key rotation by regenerating the key (procedure *not verified*). |
| Merge of a stale PR | CI re-validation plus "up to date" branch protection (D-MSSO-9). |
| Audit database outage blocks all edits | Accepted (fail-closed); GitOps edits by hand remain possible. |
| Stuck active request blocks new ones | Admin cancel / SQL procedure (D-MSSO-13). |
| `reason` text injects Markdown/links into the PR | Length cap, escaped rendering, never interpreted as instructions. |

## Open Owner Questions

1. **Create the GitHub App and its Secret** (App ID, installation ID, private key in `platform-system`), and apply a ruleset that limits App writes to `refs/heads/sso/*`.
   - *Recommendation*: yes, before rollout step ④.
2. **Add the Secret to the DR and Kakao redeploy checklists.**
   - *Recommendation*: yes; it is not in Git.
3. **Branch protection on `main`: require `independent-review` and "up to date before merging"?**
   - *Recommendation*: yes to both before the write path is enabled.
4. **Order against ADR-0008**: `applied` detection needs the read-only ArgoCD account.
   - *Recommendation*: land that account first, or ship without `applied` (stop at `merged`).
5. **Exact `groups` claim name, `admins` value format, `X-Userinfo` encoding and the Keycloak groups mapper `userinfo.token.claim` setting in the live realm.**
   - *Recommendation*: read from a real token and user info before writing the authorization code and the Lua check.

(Answered by the owner on 2026-10-17 and therefore removed: committed defaults for ②a — `allowedGroups: [admins, engineers]` on both `flink` and `filer`, `catalog-ui` locked with no field (see D-MSSO-14); which fields are editable — `allowedGroups` only; Manager namespace — `platform-system`; audit store placement — dedicated cluster; authorization engine for the first iteration — in-process.)

## Owner manual tasks (summary; detailed runbook is a follow-up)

1. Create a GitHub App with Contents/Pull requests write and Metadata read; install it on `dasomel/beluga` only. Generate a private key (PEM).
2. Create the App Secret in `platform-system` (never commit it); add it to the DR and Kakao redeploy checklists (`csp/kakao-cloud/README.md`). The Manager Pod picks it up on its next start (a missing optional Secret only keeps the writer off), so restart the Deployment afterwards:

   ```bash
   kubectl create secret generic manager-github-app -n platform-system \
     --from-literal=app-id=<APP_ID> --from-literal=installation-id=<INSTALLATION_ID> \
     --from-file=private-key.pem=<path-to-private-key.pem>
   kubectl rollout restart deployment/manager-domain-api -n platform-system
   ```

3. Configure the ruleset and branch protection. Ruleset on `refs/heads/main`: require a pull request and the `independent-review` status, "require branches to be up to date", and **no bypass actor for the App**. A second ruleset (or the App's own permission) must let the App create and update only `refs/heads/sso/*`, so its credentials cannot push to `main` (ruleset capability *not verified*). Verify with `tests/25-manager-sso-github.sh --create-pr` after the Secret exists: it opens one `sso/flink-*` PR, replays it, cancels it, and never merges.
4. Approve the new host `manager.local.beluga.internal`.

## Rollout and follow-up tasks

- **① Decision document**: this ADR (and its Korean twin) reviewed and merged. *Acceptance*: independent review PASS on the head SHA.
- **②a Platform consumer (GitOps PR)**: `allowedGroups` in `sso.yaml` schema, Lua check in `10-apisix-route.yaml`, committed defaults, session cap, `check-gateway-sso.py` contract and self-tests, `tests/20-gateway-sso.sh` 200/403 cases. *Acceptance*: `check-gateway-sso.py` passes with negative self-tests (missing check, wrong order, group mismatch); live, after ArgoCD applied the committed values: `beluga-admin` 200 / `beluga-engineer` 403 on `flink`, `beluga-engineer` 200 / `beluga-analyst` 403 on `filer`, at the registry host (not only the Service); this live pass is the condition for turning the Manager's edit switch on.
- **②b Manager deployment, identity, read**: Deployment/Application in `platform-system`, APISIX route for `manager.<baseDomain>` (added to the `AGENTS.md` registry and `/etc/hosts` instructions), Keycloak client `beluga-manager` via `keycloak-clients`, JWT validation (RS256 pinned), in-process `admins` authorization with unit tests, GitHub read adapter with source SHA/time on screen. *Acceptance*: login at the new host through the gateway; unauthenticated 401, non-`admins` 403; `GET /sso` shows the `main` SHA.
  - *Status (deployment PR, facts only)*: the `beluga-platform` chart now declares `manager-domain-api` and `manager-web` (one replica each, namespace `platform-system`, images pinned by digest from main f48b2b5, recorded in `VERSIONS.md`), the `ApisixRoute` `manager` for `manager.<baseDomain>` (`/api/*` to the Domain API, the rest to the SPA, no gateway `openid-connect`, `limit-req` on both entries) and the public Keycloak client `beluga-manager` (PKCE `S256`, `directAccessGrants` off, client-specific `groups` mapper with `full.path=true` and audience mapper, the shared `groups` scope deliberately not assigned) in both the realm import and the `keycloak-clients` Job. `sso.yaml` lists the endpoint `manager` (`app-oidc`). The SPA `config.json` requests `openid profile email` because the SPA default scope `groups` would be rejected by this client (`invalid_scope`). The web and API share one origin, so the localhost CORS in `app.ts` is not touched. The acceptance items above (login through the new host, 401, non-`admins` 403, `GET /sso` showing the `main` SHA) have not been run against a live cluster by this change.
- **③ Audit DB, idempotency, preview**: dedicated CNPG cluster, migrations, writer role, `sso_change_requests` with `file_path`, the partial unique index and advisory lock, idempotency, stale detection, semantic preview, CI contract and helm render check on PRs. *Acceptance*: killing the database makes writes 503 with no GitHub call; concurrent submits yield one active request; an unchanged group set gives 422; invariant violations give 422.
- **④ GitHub App write and UI** (*status*: ③ is merged and live; ④ is in progress. Code, chart wiring and the static render contract land together; without the owner's Secret everything stays inert, see D-MSSO-15 to D-MSSO-19): App adapter (key from a kubelet-mounted Secret, no Secret Role), submit, recovery, cancel, form, diff preview, banner, polling of PR and ArgoCD (Kubernetes API, D-MSSO-16). *Acceptance*: PR created from `sso/*` only; replay returns the same record; stage reaches `applied` only when both Applications are `Synced` at or after `mergeCommitSha`; an unrelated `OutOfSync` leaves `merged`.

# ADR-0003: Beluga is the data-platform plane

- Status: Accepted (Q1 and Q3 decided 2026-10-07; Q2 still open)
- Date: 2026-10-02
- Supersedes: —
- Superseded by: —

## Context

Issue #99 asks Beluga to integrate Narwhal, KubeMetal, kube-ready-box, ldapium and
nfs-quota-agent through explicit contracts instead of reimplementing what they own.
The OpenForge registry (`portfolio/capability-ownership.json`,
`openforge-capability-ownership/v1`) gives each capability one owner and states that a
consumer opens an integration or consumer-contract issue rather than a duplicate
implementation. It assigns `data-platform-lakehouse` to Beluga (control surface:
beluga-manager, consumers: none) and lists `beluga` as a consumer of
`kubernetes-platform-control-plane`, `node-runtime-foundation`,
`directory-identity-data-plane`, `local-edge-ai-runtime` and
`filesystem-quota-enforcement`.

Beluga's own record disagrees with the registry on one point: design decisions D11 and
D13 self-host the gateway and SSO "to run standalone without narwhal", and
`.openforge/status.json` registers Narwhal as `peer`, answered `not-applicable` in
[cross-oss-integration-contracts.md](../cross-oss-integration-contracts.md).

The evidence-based matrix is in [portfolio-integration-matrix.md](../portfolio-integration-matrix.md).

## Decision

1. Beluga is the **data-platform plane**: ingestion, streaming, lakehouse storage and
   catalog, query, orchestration, governance, data access policy and data-platform
   semantics (#97 taxonomy A-O minus the platform-foundation items it consumes).
2. Beluga does not own, and does not open implementation issues for, capabilities the
   registry assigns elsewhere: cluster lifecycle (Narwhal), node image and readiness
   (kube-ready-box), directory lifecycle (ldapium), local AI runtime (KubeMetal),
   filesystem quota enforcement (nfs-quota-agent). Needs in those areas become
   consumer-contract issues.
3. Existing self-hosted overlaps (Keycloak, APISIX, bootstrap scripts, LDAP packaging,
   node prep) are recorded as documented exceptions with one assigned source of truth
   and a sunset condition each (matrix section 2); they are not removed by this ADR.
4. The Beluga / beluga-manager OIDC, OPA and Keycloak seam is unchanged. Beluga's
   Keycloak remains the single source of identity and roles for the data-platform realm.
5. AI stays optional (#90): no core path depends on KubeMetal or any model runtime, and
   AI-derived fields never overwrite deterministic fields.
6. No contract surface is considered usable until it is evidenced in the owning
   repository; unevidenced surfaces are `unavailable` / *proposed* and are not
   API commitments.

## Alternatives considered

- **Adopt Narwhal as the lifecycle and identity substrate** (the literal registry
  reading) — rejected by the Q1 decision: it reverses D11/D13 and the standalone profile.
- **Keep Beluga fully self-contained, ignoring the registry** — rejected: it makes
  duplicate-implementation drift invisible, which #99 exists to prevent.
- **Write schemas for every boundary now** — rejected: the sibling repositories are
  actively maintained by their own sessions; Beluga-invented schemas would be
  speculative contracts.

## Consequences

- The matrix becomes the reference for #99 triage: a new Beluga issue touching an
  owned capability is an integration issue.
- `portfolio/capability-ownership.json` and Beluga's `.openforge/status.json` use
  different relationship vocabularies; Q3 is decided in favour of extending the registry
  (`peer`, `unavailable`, `not-applicable`), so `.openforge/status.json` stays unchanged.
  Until the OpenForge registry change lands, the matrix still reports both.
- Several current Beluga artifacts are explicitly labelled exceptions with sunset
  conditions, which creates follow-up work but no immediate behavior change.

## Open questions (owner decisions needed)

| ID | Question | Why it matters | Suggested owner |
|---|---|---|---|
| Q1 | **Decided 2026-10-07:** Beluga is a `peer` of Narwhal with a standalone profile (D11/D13); it does not consume `kubernetes-platform-control-plane`. The registry's consumer entry is to be corrected in OpenForge. | The registry and `.openforge/status.json` disagreed. | portfolio owner (OpenForge) |
| Q2 | If Beluga is ever hosted on Narwhal, may it share Narwhal's Keycloak realm and APISIX, or must the data-platform realm stay separate? | Defines the OIDC/RBAC seam with beluga-manager. | Beluga + Narwhal + beluga-manager |
| Q3 | **Decided 2026-10-07:** add `peer`, `unavailable` and `not-applicable` to the registry's `allowed_relationships`; `.openforge/status.json` is not rewritten. | `.openforge/status.json` uses values the registry did not list. | OpenForge |
| Q4 | Adopt `ldapium:charts/ldapium` as a dependency, or keep the Beluga-rendered LDAP manifests? | Removes the LDAP packaging duplicate (D5) but changes GitOps ownership. | Beluga + ldapium |
| Q5 | Is Beluga to deploy observability itself, consume Narwhal's, or defer? `VERSIONS.md` lists Prometheus Stack but nothing is deployed. | Drift candidate (D8); blocks capacity-evidence and operations lanes. | Beluga |
| Q6 | Who defines the readiness evidence schema Beluga reads: kube-ready-box's `kube-ready-readiness/v1`, or Beluga's `ready` + `findings[]` gate? | The two differ today (matrix 3.3). | Beluga + kube-ready-box |
| Q7 | Will Beluga ever introduce NFS/RWX storage? | Decides whether nfs-quota-agent stays `not-applicable`. | Beluga |
| Q8 | Where does a first KubeMetal consumption point live (#80, #90), and what is the network path from a Vagrant cluster to a macOS host runtime? | No adapter work is justified until a caller exists. | Beluga + KubeMetal |
| Q9 | Which ldapium release tag replaces `nightly-4e85165`, and does it contain 2.6.14 or 2.6.15? | Release-tag contract is `partial`. | ldapium |

## Affected standards, templates, and projects

- `docs/portfolio-integration-matrix.md` (and `-ko`), `docs/cross-oss-integration-contracts.md`
- Related: ADR-0001 (standalone Vagrant + k3s + GitOps), issues #90, #97, #99
- Read-only references: OpenForge, Narwhal, KubeMetal, kube-ready-box, ldapium,
  nfs-quota-agent (no changes proposed to them here)

## Migration / adoption

None. Documentation only; promotion to Accepted required answers to Q1 and Q3, both given on 2026-10-07. Q2 remains open and gates only a future Narwhal-hosted profile.

## Evidence and references

- `openforge:portfolio/capability-ownership.json`, `openforge:docs/portfolio-capability-ownership.md`
- [portfolio-integration-matrix.md](../portfolio-integration-matrix.md)
- `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md` (D11, D13, D14)
- Issue #99 comment of 2026-09-18 (Narwhal resolved as `peer`)

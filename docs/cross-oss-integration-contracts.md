# Cross-OSS integration contracts

English | [한국어](cross-oss-integration-contracts-ko.md)

This document records Beluga's side of five cross-OSS boundaries raised in
[issue #99](https://github.com/dasomel/beluga/issues/99): Narwhal, KubeMetal,
kube-ready-box, ldapium, and nfs-quota-agent. It states only what Beluga
expects or already consumes from each project — it does not prescribe changes
to those repositories. For Beluga's own architecture, see
[docs/architecture.md](architecture.md); for the underlying design decisions
(D1, D5, D9, D11, D13, D15, D16, D20) referenced below, see
[docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md](superpowers/specs/2026-08-09-beluga-data-platform-design.md).

Status values follow issue #99's four-state model: `supported`, `partial`,
`unavailable`, `not-applicable`.

## Summary

| Boundary | Category | Status today | Real integration work remaining |
|---|---|---|---|
| ldapium | Done, documentation only | supported/partial | none — consumed contract just needs writing down |
| kube-ready-box | Partial, buildable now | partial | the only boundary with genuine incremental integration work: opt-in evidence-gate wiring |
| Narwhal | Resolved by design decision | peer / not-applicable | none — decided not to integrate, D11/D13 stand |
| KubeMetal | Pure aspiration, deferred | unavailable | none in this pass — no consumption point exists yet, deferred to #90/#80 |
| nfs-quota-agent | Pure aspiration, substrate absent | not-applicable | none — no NFS/RWX storage exists to enforce quota on |

**kube-ready-box is the only boundary with real incremental integration work in this pass.**
Everything else is either already true (ldapium), resolved by an explicit design
decision (Narwhal), or correctly deferred pending a prerequisite that doesn't
exist yet (KubeMetal's consumption point, nfs-quota-agent's storage substrate).

## 1. ldapium ↔ Beluga — `supported` (directory data plane) / `partial` (lifecycle)

Beluga runs ldapium as its LDAP server image:
`ghcr.io/dasomel/ldapium:nightly-4e85165` (VERSIONS.md:38, D20), with
`ldapium-ui:nightly-d1b7b9e` pinned but not deployed (VERSIONS.md:39).

Beluga owns, in `gitops/charts/beluga-platform/templates/openldap.yaml`:
Service (389/636), a cert-manager `Certificate` (openldap-tls), two PVCs
(openldap-data 2Gi, openldap-config 1Gi), a seed-LDIF ConfigMap, the
Deployment and its `securityContext`, `ldapwhoami` probes, and the
`openldap-init` Job (`openldap.yaml:277`).

A `postStart` hook (`openldap.yaml:192-241`) idempotently runs `ldapmodify`
against `cn=config` to apply TLS configuration, because the image only bakes
TLS at first bootstrap on an empty volume. This is a Beluga-owned workaround
with its own sunset condition: it is removed once the consumed image
converges TLS config on an already-bootstrapped volume — not a demand on
ldapium.

**Contract Beluga consumes today (real):**
- Env vars: `LDAP_ROOT_DN`, `LDAP_ORG_NAME`, `LDAP_ADMIN_DN`,
  `LDAP_ADMIN_PASSWORD`, `LDAP_TLS_ENABLED`, `LDAP_TLS_CERT_FILE`,
  `LDAP_TLS_KEY_FILE`, `LDAP_TLS_CA_FILE`, `LDAP_SEED_DIR`.
- Mount paths: `/var/lib/openldap/data`, `/etc/openldap/slapd.d`,
  `/var/lib/openldap/run`.
- Runtime posture: non-root UID/GID 999, `readOnlyRootFilesystem`.

Downstream, Keycloak federates via `ldaps://openldap.iam.svc.cluster.local:636`,
`usersDn=ou=users,dc=beluga,dc=internal`, `editMode=WRITABLE`
(`keycloak-ldap-federation.yaml:186-191`).

**Gaps** (zero evidence in-repo): no backup/restore, no
replication/syncrepl anywhere; the version contract today is just a
nightly-tag pin plus one CI allowlist exception line in
`.github/image-tag-allowlist.txt`.

**Buildable now in this pass:**
- The consumed-contract table above (already true, documented here).
- Register a `.openforge/status.json` relationship
  `{target: "ldapium", type: "consumes", scope: "OpenLDAP directory data plane"}`
  (see [Follow-ups](#follow-ups-not-done-in-this-pass)).
- The postStart hook's removal condition, stated explicitly above.

**Blocked on ldapium's own work:** stable release tags, a backup/restore
contract, a replication contract.

## 2. kube-ready-box ↔ Beluga — `partial`

Beluga only consumes the `dasomel/ubuntu-26.04-xfs` box (`Vagrantfile:25,27`,
`configs/cluster.env:22`). No Packer/box-build files exist in this repo (zero
`*.pkr.hcl` hits). `VERSIONS.md:15` already delegates license/NOTICE
ownership to the kube-ready-box repo — that boundary is already correctly
drawn.

Node-prep logic overlaps kube-ready-box's domain, however:
`scripts/cluster/01-node-prep.sh:12-34` disables swap, loads kernel modules
(`overlay`, `br_netfilter`), and configures sysctls itself — this is
"Kubernetes-ready node foundation" territory that a box-level tool would
normally own.

No node-level preflight/readiness tooling exists (only one filename match —
`tests/11-identity-plaintext-preflight.sh`, an unrelated SSO/TLS static
check, not box-level readiness tooling — otherwise zero hits for
precheck/readiness/doctor/diagnos* script names). No box
provenance verification exists either (zero `cosign` hits; boxes are
referenced by name only, with no checksum or digest verification) — in
contrast, Beluga verifies its own JAR supply chain with `sha256sum -c`
(`gitops/charts/beluga-data/templates/14-flink-jobs.yaml:67-75`,
`05-flink-operator.yaml:49-56`). The OS image currently has weaker
supply-chain verification than a JAR file.

Beluga already has a structured evidence idiom
(`scripts/agent/operations_agent.py:65-90,292`, `ExecutionEvidence`,
`schema_version="beluga-agent-evidence/v1"`), but it operates at
cluster level via `kubectl`, not at node level.

**Contract Beluga would consume (its own expectation, not negotiated):**
one JSON object per node, following the `beluga-agent-evidence/v1` naming
idiom:
- node identity — name, role, OS/kernel version, box identity + digest
- readiness — swap off, kernel modules loaded, required sysctls set,
  container runtime present
- storage — filesystem type/XFS, prjquota enabled, free capacity
- top-level `ready: true|false` plus a `findings[]` array

**Buildable now in this pass:**
- Document the expected schema above.
- Add an opt-in gate to `scripts/up.sh` that reads a readiness report from a
  configured path but no-ops if the file doesn't exist — never breaks
  today's install flow (see [Follow-ups](#follow-ups-not-done-in-this-pass)).
- Register a `.openforge/status.json` relationship
  `{target: "kube-ready-box", type: "consumes", scope: "node OS image; readiness evidence (expected)"}`.

**Blocked on kube-ready-box's own work:** actually producing the readiness
report; publishing box digests/checksums.

## 3. Narwhal ↔ Beluga — decided: register as `peer`, respond `not-applicable`

**Human decision (already made):** issue #99's framing of "use Narwhal as
the platform lifecycle/control-plane source of truth" is not adopted.
Instead, the relationship is registered as `peer` (not `consumes`), and the
answer to #99's integration-matrix requirement for this boundary is
`not-applicable` for the standalone profile. D11 and D13 remain fully in
force — no code changes, and no future narwhal-hosted profile is being
committed to at this time.

Zero integration code exists between the two repos. Every reference is
design lineage, not consumption:
- Beluga mirrored Narwhal's skeleton (Vagrant + same box + ArgoCD GitOps)
  per `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md:14,165`,
  which explicitly states Beluga "mirrors narwhal" repo structure.
- D16 (`:53`) chose k3s instead of Narwhal's kubeadm.
- D1 (`:38`) chose the `192.168.77.x` subnet specifically to avoid
  collision when running simultaneously with Narwhal (`192.168.56.x`) —
  i.e. the two were designed as coexisting peers, not a dependency
  hierarchy.
- D11/D13 (`:17,29`) explicitly self-host SSO (Keycloak) and the API
  gateway (APISIX) "to run standalone without narwhal," and the design
  spec explicitly states Beluga "does not reference a narwhal instance."

Beluga and Narwhal share design patterns — the same Vagrant box, the ArgoCD
app-of-apps pattern, the SeaweedFS S3 choice (D5), bootstrap-time
random-credential generation (D15), the single CNPG operator pattern (D9),
and the arm64 manifest verification gate learned from the harbor
"exec format error" incident (`:404`). These are inherited patterns, not
duplicated implementations — which honestly answers #99's "identify
duplicate implementation candidates" requirement without reversing any
design decision.

The reverse-boundary rule holds regardless of the peer/not-applicable
decision: Iceberg/Trino/Flink and data-product semantics stay in Beluga and
never move to Narwhal.

**Buildable now in this pass:**
- Register a `.openforge/status.json` relationship
  `{target: "narwhal", type: "peer", scope: "shared platform patterns; no runtime dependency"}`.
- Document the shared-patterns list above.
- Document the reverse-boundary rule above.

Not blocked on Narwhal's own work at all — this boundary's status is fully
determined by Beluga's own, already-made design decision, independent of
what Narwhal does.

## 4. KubeMetal ↔ Beluga — `unavailable`

Zero AI capability exists anywhere in this repo. An exhaustive grep across
ai/llm/inference/embedding/ollama/openai/gpu/mps/metal (excluding MetalLB)
/vllm/multimodal/whisper/ocr returns zero hits; there are zero Apple
Silicon/Metal/hardware-acceleration mentions. The only two mentions of
KubeMetal are in the design spec, both explicitly future-tense:
`...design.md:24` ("complete the infra/AI/data trilogy alongside
narwhal/kubemetal") and `:31` ("ML feature store / kubemetal integration —
recorded as a future expansion candidate only"). Note:
`scripts/agent/operations_agent.py` has "agent" in its name but is a
read-only kubectl wrapper plus policy/evidence proof-of-concept — no model
calls, no inference — it should not be miscounted as AI capability.

More fundamentally, Beluga has no consumption point for an AI adapter to
attach to yet: document/image/media enrichment, semantic tagging, and
classification are all unimplemented backlog (issues #73/#79/#80), and
there is currently no text/document/media processing pipeline in this repo
at all. Building an adapter now would be an interface with no caller —
speculative implementation that this document deliberately does not do.

This section therefore documents only the boundary's existence and the
constraint from issue #90: AI-optional architecture — KubeMetal must be
optional, default-off, provider-unspecified, and AI-derived fields must
never overwrite deterministic fields.

**Contract sketch for reference only** (Beluga's expectation, not
negotiated, deferred until #90/#80 create a consumption point):
- An OpenAI-compatible endpoint shape (`/v1/chat/completions`,
  `/v1/embeddings`) as a vendor-neutral adapter boundary, satisfying #90's
  swap-without-redesign requirement.
- A `/healthz` readiness check with a documented fallback to a non-AI path
  on failure.
- Per-invocation provenance `{model, model_version, runtime, run_id,
  prompt_digest}` for lineage attachment.
- AI vs non-AI resource/cost/latency telemetry measured separately.

Since KubeMetal is a local/offline backend, this is explicitly "not
external egress" rather than requiring a pre-send privacy/classification
gate.

**Recommendation:** defer actual adapter implementation to the #90 backlog.
This document only records the boundary and its constraint; it builds
nothing.

## 5. nfs-quota-agent ↔ Beluga — `not-applicable`

No duplication exists, because the capability itself is not implemented in
this repo. Zero `nfs`/`NFS`/`nfs-subdir`/`nfs-client` hits exist anywhere.
Storage uses k3s's default `local-path` provisioner by omission — no PVC
anywhere sets `storageClassName` (zero hits for storageClass/local-path/
hostPath as explicit config). Only four PVCs exist in total:
`seaweedfs-data` 5Gi (`01-seaweedfs.yaml:161-168`, RWO), `apisix-etcd-data`
1Gi (`apisix-infra.yaml:10-19`), and `openldap-data` 2Gi +
`openldap-config` 1Gi (`openldap.yaml:49-69`).

Zero quota/ResourceQuota/LimitRange/xfs_quota/prjquota/diskPressure/capacity
hits exist anywhere — no namespace `ResourceQuota`, no disk-headroom check
script, no capacity monitoring (no Prometheus alert rules exist in this
repo at all). XFS appears only in the box name
(`dasomel/ubuntu-26.04-xfs`) — a natural prjquota foundation, but nothing
in this repo configures it; the choice is baked into an external box
image, and the `Vagrantfile` has no disk-size configuration at all, only
RAM/CPU vars.

`not-applicable` (rather than `unavailable`) is the honest label here:
`unavailable` would read as a roadmap promise, but there is no NFS/RWX
storage class in any profile and no stated goal to introduce one. Of #99's
four semantic states (`supported`/`partial`/`unavailable`/
`not-applicable`), this is the only one that matches reality.

**Motivating context** (a real, already-documented incident):
`01-seaweedfs.yaml:136-141` carries an inline comment recording that
`/data` originally had no PVC, data was written to the container's
writable layer, and a pod restart during an S3-auth rollout lost existing
Iceberg data (orders, customers, events_enriched) before a PVC was added.
This is why a capacity-evidence *consumer* contract — not an enforcement
contract — is worth documenting even though enforcement itself does not
apply yet.

**Contract Beluga would consume (expectation, not negotiated)** — a
capacity evidence *consumer* schema only, not enforcement, following the
`beluga-agent-evidence/v1` field-naming idiom: per-PVC record
`{namespace, claim, storage_class, used_bytes, limit_bytes, source,
observed_at}`, where `source` names the producer (`nfs-quota-agent` /
`local-path` / `manual`) — this field is what makes the schema useful today
regardless of whether nfs-quota-agent is ever adopted. Uses: profile
sizing, data lifecycle (#18, Iceberg retention/purge),
`.openforge/status.json` status reporting, and resource governance (#38).

**Buildable now in this pass:**
- Document the capacity-evidence consumer schema above (producer-agnostic).
- Register a `.openforge/status.json` relationship
  `{target: "nfs-quota-agent", type: "not-applicable", scope: "filesystem quota enforcement; no NFS/RWX storage class in any profile"}`
  as an explicit reply, not a silent omission.
- Cite the SeaweedFS data-loss incident above as the honest motivating
  context for documenting a consumer schema for a not-yet-applicable
  capability.

**Blocked on:** everything else — specifically, writing an enforcement
contract for storage that doesn't exist would dress up a wishlist as a
contract. This is blocked on Beluga's own storage-architecture decision
(whether to ever introduce NFS/RWX), not on nfs-quota-agent's work.

## Follow-ups not done in this pass

1. Actually registering the five `.openforge/status.json` `relationships`
   entries described above (separate PR).
2. Implementing the kube-ready-box opt-in evidence gate in `scripts/up.sh`
   (separate PR).
3. `portfolio/capability-ownership.json` from OpenForge PR #79 is a
   related artifact worth linking to once available — it is **not** part
   of this workspace, and its field names are unverified from here.

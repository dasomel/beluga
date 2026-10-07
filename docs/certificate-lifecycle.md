# Certificate Lifecycle, Renewal and Expiry Controls (Proposal)

English | [한국어](certificate-lifecycle-ko.md)

Refs issue [#47](https://github.com/dasomel/beluga/issues/47) ("Establish certificate lifecycle, renewal, and expiry controls").

> **Status: PROPOSAL. Documentation only.** No manifest, script, `VERSIONS.md` entry or policy is changed by this
> document. Every statement about the repository carries a `file:line` read at commit `9f74c2b`. Every statement about
> the live cluster comes from a read-only `kubectl` command run on 2026-10-07 (commands in [section 2.3](#23-live-state-measured-2026-10-07)), or is marked
> **not verified live**. External facts cite [Sources](#sources) (accessed 2026-10-07); where no official recommendation
> was found it says so. Numbers marked **Proposed** have no repository or upstream basis and need an owner decision.

Related: [`docs/development.md`](development.md) (certificate inventory gate), [`docs/privileged-access-inventory.md`](privileged-access-inventory.md),
[`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (row C03),
[`docs/environment-profiles.md`](environment-profiles.md) (secure-profile preflight design).

## 1. Purpose and issue mapping

Issue #47 asks for a certificate lifecycle covering issuance, renewal, trust distribution, expiry monitoring and
controlled replacement. Its Background states that `VERSIONS.md` lists cert-manager as not installed. **That is stale**:
`VERSIONS.md:18` lists cert-manager 1.21.1, `scripts/gitops/01-argocd-bootstrap.sh:295-300` installs it, and three cert-manager pods
were running on the live cluster (2.3). The remaining gaps are therefore operational (live evidence, alerting, CA rotation, non-cert-manager
certificates), not "cert-manager is absent".

## 2. Current state (verified)

### 2.1 What the repository defines

| Area | Fact | Source |
|---|---|---|
| Installer | cert-manager v1.21.1 applied from a SHA-256-verified release manifest | [`01-argocd-bootstrap.sh:295-300`](../scripts/gitops/01-argocd-bootstrap.sh#L295-L300), [`VERSIONS.md:18`](../VERSIONS.md#L18) |
| Issuer model | Self-signed bootstrap `ClusterIssuer` -> CA `Certificate` `beluga-internal-ca` (isCA, RSA 2048, duration 8760h, renewBefore 2920h) -> CA `ClusterIssuer` `beluga-internal-ca-issuer`. The file states that no external ACME issuer is needed | [`cert-manager-issuer.yaml:1-4`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L1-L4), [`:11-18`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L11-L18), [`:21-38`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L21-L38), [`:44-51`](../gitops/charts/beluga-platform/templates/cert-manager-issuer.yaml#L44-L51) |
| Leaf certificates | Gateway wildcard, Trino coordinator (with PKCS12 keystore), OpenLDAP, and the Kafka OAuth trust certificate: all `duration: 2160h`, `renewBefore: 720h`, issuer `beluga-internal-ca-issuer` | [`apisix-gateway.yaml:247-265`](../gitops/charts/beluga-platform/templates/apisix-gateway.yaml#L247-L265), [`06-trino.yaml:124-150`](../gitops/charts/beluga-data/templates/06-trino.yaml#L124-L150), [`openldap.yaml:34-52`](../gitops/charts/beluga-platform/templates/openldap.yaml#L34-L52), [`03-strimzi-kafka.yaml:380-394`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L380-L394) |
| Kafka OAuth trust certificate | Rendered only when `strimzi.oauthListener` is true | [`03-strimzi-kafka.yaml:373`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L373) (closing `end` at `:395`) |
| Kafka listener TLS | Internal `plain` listener has `tls: false` unless `strimzi.listenerTls` is set | [`03-strimzi-kafka.yaml:64-67`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L64-L67) |
| CA trust distribution | A Sync-hook Job copies `ca.crt` into a ConfigMap `beluga-internal-ca` in `iam`, `analytics`, `orchestration`, `lakehouse`; it overwrites `ca.crt` with the current CA only | [`internal-ca-distribution.yaml:25`](../gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml#L25), [`:87-96`](../gitops/charts/beluga-platform/templates/internal-ca-distribution.yaml#L87-L96) |
| Static inventory gate | `check-certificate-inventory.py` runs in `make validate` ([`Makefile:84`](../Makefile#L84)): every TLS reference needs a cert-manager Certificate with explicit `duration`/`renewBefore`, `renewBefore < duration`, no inline TLS Secret data. It states it does **not** verify live expiry, renewal/reload, CA redistribution, alerting or invalid-certificate behavior | [`development.md:149-206`](development.md#L149-L206) |
| Fail-closed trust test | A live test rejects HTTPS without the internal CA (no `-k`) and verifies the chain with `--cacert` | [`tests/10-tls-identity-boundary.sh:1-12`](../tests/10-tls-identity-boundary.sh#L1-L12) |
| Expiry checks | Searched `scripts/`, `tests/`, `Makefile`, `.github/` for `notAfter`, `checkend`, `enddate`, `renewalTime`: no match. **No expiry preflight or release check exists in those paths** | search on this commit |
| Alerting | `prometheusGrafana.enabled: true` only renders a NodePort Service `grafana-external`; searched `gitops/` and `scripts/` for `prometheusGrafana`, `kube-prometheus`, `prometheus-community`: no manifest deploys a Prometheus/Grafana workload | [`values.yaml:18-22`](../gitops/charts/beluga-platform/values.yaml#L18-L22), [`platform-services.yaml:8-23`](../gitops/charts/beluga-platform/templates/platform-services.yaml#L8-L23) |

### 2.2 Certificates the repository does not issue through cert-manager

| Certificate | Issuer / controller | Repository basis |
|---|---|---|
| PostgreSQL server/replication certs | CloudNativePG operator CA (no `spec.certificates` in the manifest) | [`02-cnpg.yaml`](../gitops/charts/beluga-data/templates/02-cnpg.yaml): searched case-sensitive for `tls`, `ssl`, `cert`: no match; operator defaults apply |
| Kafka cluster/clients CA and broker certs | Strimzi-generated (no `clusterCa`/`clientsCa` in the Kafka spec; live spec empty) | [`03-strimzi-kafka.yaml`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml): searched `clusterCa`, `clientsCa`, `generateCertificateAuthority`, `validityDays`, `renewalDays`: none |
| Kubernetes API serving/client certs | k3s | installed by [`02-k8s-init.sh:32`](../scripts/cluster/02-k8s-init.sh#L32) with no certificate flags |
| Hubble, CNPG webhook | Cilium CA / CNPG webhook CA | observed live only |

### 2.3 Live state (measured 2026-10-07)

Commands: `kubectl get certificate -A -o custom-columns=...`, `kubectl get clusterissuer,issuer -A`, `kubectl get pods -n cert-manager`,
`kubectl get secret -A --field-selector type=kubernetes.io/tls`, and `openssl x509 -noout -subject -issuer -dates` on the **public** `tls.crt`/`ca.crt`
of selected Secrets (private keys not read). Server clock `date -u`: 2026-10-07T14:06Z; cluster age 3d6h.

| Certificate (live) | Issuer | duration / renewBefore | notAfter | renewalTime |
|---|---|---|---|---|
| `cert-manager/beluga-internal-ca` (CA) | `selfsigned-bootstrap` | 8760h / 2920h | 2027-10-04 | 2027-06-04 |
| `analytics/trino-coordinator-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |
| `iam/openldap-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |
| `platform-system/apisix-gateway-tls` | `beluga-internal-ca-issuer` | 2160h / 720h | 2027-01-02 | 2026-12-03 |

| Non-cert-manager (observed) | notAfter | Validity observed |
|---|---|---|
| `database/postgres-main-server`, `-replication`, CNPG CA (Cluster `status.certificates.expirations`) | 2027-01-02 | 90 days |
| `cnpg-system/cnpg-webhook-cert` | 2027-01-02 | 90 days |
| Strimzi cluster CA and clients CA (`CN=cluster-ca v0`, `clients-ca v0`) | 2027-10-04 | 365 days |
| `kube-system/k3s-serving` | 2027-10-04 | 365 days |
| `kube-system/hubble-server-certs` (Cilium CA) | 2027-10-04 | 365 days |

Other live facts: ClusterIssuers `selfsigned-bootstrap` and `beluga-internal-ca-issuer` Ready ("Signing CA verified"); ConfigMap `beluga-internal-ca`
present in the four namespaces above; `cert-manager` pods Running but with restarts (controller 35, cainjector 242, webhook 2; cause **not investigated**);
`monitoring.coreos.com` CRDs: 0; no Prometheus/Grafana pods, while Service `grafana-external` exists; `beluga-kafka-oauth-ca` Secret absent (consistent with `oauthListener` off).
**No renewal has ever happened on this cluster** (certificates are 3 days old), so renewal, reload and CA re-trust are **not verified live**.

### 2.4 Upstream facts used

Every external fact below carries its source ID; URLs and access date (2026-10-07) are in Sources. Facts not read from an official page are marked not verified.

- cert-manager: default `spec.duration` 90 days; renewal by default 2/3 through the duration (i.e. a third remaining); minimum duration 1h, minimum effective
  `renewBefore` 5 min; from v1.18.0 the default `privateKey.rotationPolicy` is `Always`; manual renewal via `cmctl renew` [S1].
- k3s: client/server certificates valid 365 days, renewed at k3s start if expired or within 120 days of expiry (90 days before May 2025 releases); CA valid 10 years and
  not auto-renewed; `k3s certificate rotate`, `rotate-ca`, `check` exist [S2].
- CloudNativePG: operator-generated certificates valid 90 days, renewed 7 days before expiry without downtime; user-supplied server/client certificates must be re-issued by the user [S3].
- cert-manager metric names for certificate expiry: the metrics page read lists only Venafi metrics and points to a third-party mixin; **no official certificate-expiry alert recommendation was found** [S4].
- Strimzi CA `validityDays`/`renewalDays` defaults: **not verified** (the sections read did not contain the schema); live CA validity is 365 days (2.3).

## 3. Gaps against the acceptance criteria

| Acceptance criterion | Status | Why |
|---|---|---|
| Inventory for all production TLS endpoints | **Partial** | Static inventory of cert-manager Certificates exists and is not persisted ([`development.md:149-206`](development.md#L149-L206)); no owner/purpose field; CNPG, Strimzi, k3s, Cilium certificates are not in it; "production profile" is not defined yet (see environment profiles) |
| Renewal automated or repeatable, tested before expiry | **Partial** | cert-manager renews automatically by design [S1]; no renewal has been exercised, and no test forces one |
| Expiry alerts actionable | **Not met** | No monitoring stack deployed; no alert rule; no expiry check in preflight/release |
| Rotation without manual manifest editing | **Partial (CA)** | Leaf rotation needs no manifest edit. CA trust distribution is a one-shot Sync-hook Job that overwrites with a single CA, so a CA key rotation has no overlap window (analysis, not tested) |
| Invalid/expired certificates fail closed | **Partial** | Untrusted-CA rejection is tested live (`tests/10`); expired and hostname-mismatch cases have no test |
| Secure-profile validation verifies trust-chain distribution | **Not met** | Inventory gate compares issuers/hosts statically only; no live check of ConfigMap contents or chain |

## 4. Proposal (all items Proposed)

### 4.1 Certificate classes, issuer and trust boundary

| Class | Examples | Issuer (Proposed) | Trust distribution | Expiry source |
|---|---|---|---|---|
| C1 external gateway leaf | `apisix-gateway-tls` | Dev: internal CA (today). Production: owner picks an enterprise or public CA (**Owner decision D1**) | Clients outside the cluster need the CA chain; today only an out-of-band copy of `ca.crt` | `Certificate.status.notAfter` |
| C2 internal service leaf | Trino, OpenLDAP, Kafka OAuth trust | internal CA | ConfigMap `beluga-internal-ca` per consuming namespace | same |
| C3 internal CA | `beluga-internal-ca` | cert-manager self-signed bootstrap (today); production root custody is **D2** | same ConfigMap, must carry old+new during rotation (4.3) | same |
| C4 Kafka CAs | Strimzi cluster/clients CA | Strimzi | Strimzi Secrets | `openssl` on Secret `ca.crt` (live) |
| C5 PostgreSQL | CNPG server/replication | CNPG (or cert-manager per [S3]; **D3**) | CNPG Secrets | Cluster `status.certificates.expirations` |
| C6 Kubernetes API | k3s | k3s | kubeconfig | `k3s certificate check` [S2] |
| C7 mesh/operator | Hubble, CNPG webhook | their controllers | internal | observed |

Inventory fields to record per row: owner, purpose, issuer, SAN list, notAfter, renewal mechanism, consumers. The repository gate already emits issuer, SANs, lifetimes and consumers;
**Proposed**: add `owner` and `purpose` as required fields in the gate output source and extend the table to C4-C7 by hand-maintained entries.

### 4.2 Expiry signals and thresholds

Three signals, evaluated for every certificate in the inventory: (a) `Ready != True`; (b) renewal overdue: now > `status.renewalTime` plus a grace period; (c) days to `notAfter` below a floor.
The grace and the floor are **no official recommendation** [S4]; **Owner decision D4**: option space is a fixed floor in days per validity class and a grace period; no number is proposed here. Reference points in this repository: leaves are issued for 2160h with renewBefore 720h and the CA for 8760h with renewBefore 2920h (2.3); a floor below the renewBefore means the alert fires only after automatic renewal was already due and has failed.
Delivery depends on **D5** (monitoring stack): with a Prometheus stack, alert rules on cert-manager metrics (names to be confirmed from the running controller's `/metrics`, port 9402 per [S4]);
without one, a read-only `kubectl` report script is the only mechanism.

### 4.3 Rotation and CA trust

- Leaf renewal: rely on cert-manager automatic renewal [S1]; the proposed test is a **forced** renewal on a disposable cluster (`cmctl renew`) followed by the live TLS checks.
- Consumer reload: record, per consumer (APISIX, Trino, OpenLDAP, CNPG), whether renewed Secret content is picked up without restart; **not verified live** for any of them.
- CA rotation: replace the overwrite behavior with a trust **bundle** (old + new `ca.crt`) distributed before the issuer switches, and remove the old CA only after all leaves chain to the new one. Redistribution must also run on CA renewal, not only on ArgoCD Sync (hook at `internal-ca-distribution.yaml:25`). Design only.
- Fail closed: add negative tests (expired leaf, wrong hostname, wrong CA) to the live TLS test set.

## 5. Verification and test ideas

1. Static: gate rejects a Certificate lacking owner/purpose annotation (after the proposed schema change); fixture-based, runs in `make validate`.
2. Live read-only: `kubectl get certificate -A` plus Secret `tls.crt` date parse; fails if any certificate has less than the floor (D4) remaining or `Ready != True`.
3. Live forced renewal on a disposable cluster: renew the gateway certificate, assert HTTPS still verifies with `--cacert` and notAfter advanced.
4. CA rotation drill on a disposable cluster: rotate `beluga-internal-ca`, assert ConfigMaps carry both CAs, then all leaves reissue, then drop the old CA; no handshake failure in `tests/10`.
5. Negative: serve an expired certificate (cert-manager `duration` minimum is 1h [S1], so a short-lived test certificate can be created) and assert clients fail.

## 6. Owner decisions remaining

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Production issuer for external gateway certificates (enterprise CA, public CA, or internal CA only) | Enterprise/public CA for C1 with the internal CA kept for C2; decide after the profile definition |
| D2 | Custody of the internal root (cluster Secret today) | Keep for non-production; production needs a decision on offline/HSM-backed root |
| D3 | Whether CNPG certificates move under cert-manager [S3] | Keep CNPG defaults (90d, auto renewal) and monitor them |
| D4 | Alert floor and grace values | No recommended number (no official source). Choose the floor relative to the repository's renewBefore values (720h leaves, 2920h CA) and the owner's response time; measure first |
| D5 | Monitoring stack (Prometheus/Alertmanager) vs script-only reporting | Decide together with issues #44/#45/#35; recommend a stack |
| D6 | Whether the inventory is persisted as release evidence | Yes, into the release evidence bundle |

## 7. Follow-up implementation tasks (ordered)

1. Add a read-only live expiry report script (kubectl only) with exit code; acceptance: exit 1 on a certificate under the floor, tested with a fixture JSON.
2. Add `owner`/`purpose` fields to the inventory and extend it to C4-C7; acceptance: gate fails on a missing field (negative fixture).
3. Add expired-certificate and hostname-mismatch cases to the live TLS test; acceptance: both fail closed.
4. Forced-renewal and consumer-reload test per consumer; acceptance: recorded result per consumer.
5. Trust-bundle distribution design + drill (4.3); acceptance: CA rotation without a failed handshake.
6. Alert rules, once D5 is decided; acceptance: a test certificate under the floor raises the alert.
7. Fix stale Background statement in the issue (cert-manager is installed) when updating the issue.

## Sources

All accessed 2026-10-07.

| ID | Source |
|---|---|
| S1 | cert-manager, Certificate resource: https://cert-manager.io/docs/usage/certificate/ |
| S2 | K3s, Certificate management: https://docs.k3s.io/cli/certificate |
| S3 | CloudNativePG v1.30.0, Certificates: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/certificates.md |
| S4 | cert-manager, Prometheus metrics: https://cert-manager.io/docs/devops-tips/prometheus-metrics/ |

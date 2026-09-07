# Beluga Service Access Guide

This guide summarizes the Beluga data platform's service access URLs, DNS configuration, kubectl access methods, credentials, and troubleshooting procedures.

> **For the Vagrant local environment**: All services are accessed consistently through `*.local.beluga.internal` domains on **port 80**, based on the APISIX gateway + MetalLB LoadBalancer.

---

## 1. Network Configuration

| Component | IP | Description |
|----------|-----|------|
| Master-1 | `192.168.77.10` | Control plane, dnsmasq DNS server (`:53`) |
| Worker-1 | `192.168.77.21` | Data workloads (DNS: Master-1 forwarding / split-DNS) |
| Worker-2 | `192.168.77.22` | Data workloads (DNS: Master-1 forwarding / split-DNS) |
| Worker-3 | `192.168.77.23` | Data workloads (DNS: Master-1 forwarding / split-DNS) |
| MetalLB VIP | `192.168.77.200` | APISIX LoadBalancer IP |

### DNS Resolution Architecture
- **dnsmasq (Master-1)**: Automatically responds to wildcard queries for `*.local.beluga.internal` with the APISIX LoadBalancer IP (`192.168.77.200`) (`scripts/cluster/10-dnsmasq.sh`).
- **Worker nodes**: The `10-worker-dns.sh` script configures a `systemd-resolved` drop-in (`/etc/systemd/resolved.conf.d/beluga-worker.conf`) so they operate as split-DNS, forwarding the `*.local.beluga.internal` domain to Master-1 (`192.168.77.10`).
- **k3s CoreDNS**: Defines the `local.beluga.internal:53` forward zone only once in the `coredns-custom` ConfigMap so Pods can resolve domains automatically. (CoreDNS crashes if the zone is defined more than once.)

---

## 2. One-Time DNS Setup on the Host (Developer PC)

### Option A: Configure the macOS resolver (official recommended method)

Using macOS's `/etc/resolver` feature automatically delegates queries only for the `*.local.beluga.internal` domain to the Master-1 dnsmasq server, without modifying `/etc/hosts`. Manual registration is unnecessary even when new subdomains are added.

```bash
sudo mkdir -p /etc/resolver
echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal
```

Verify that it works correctly after installation:
```bash
scutil --dns | grep -A 5 "local.beluga.internal"
ping -c 1 sso.local.beluga.internal
```

### Option B: Register directly in `/etc/hosts` (alternative)

If you do not use the macOS `/etc/resolver` or your host is Linux/Windows, register the domains directly in `/etc/hosts`.

```bash
sudo tee -a /etc/hosts << 'EOF'
# Beluga Data Platform (APISIX LB: 192.168.77.200)
192.168.77.200 trino.local.beluga.internal
192.168.77.200 airflow.local.beluga.internal
192.168.77.200 superset.local.beluga.internal
192.168.77.200 catalog.local.beluga.internal
192.168.77.200 s3.local.beluga.internal
192.168.77.200 flink.local.beluga.internal
192.168.77.200 argocd.local.beluga.internal
192.168.77.200 sso.local.beluga.internal
192.168.77.200 metadata.local.beluga.internal
EOF
```

---

## 3. kubectl Access Configuration

The default kubeconfig created by k3s on Master-1 (`/etc/rancher/k3s/k3s.yaml`) has its server address set to `127.0.0.1`, so it cannot be used directly from the host PC.
For host access, use the `scripts/kubeconfig.sh` script as the single access method.

### Usage 1: Create a project-local `.kube/config` (for one shell/project only)

```bash
bash scripts/kubeconfig.sh
```
- Retrieves kubeconfig from Master-1, changes the server address to `192.168.77.10`, replaces the context/cluster/user names with `beluga`, and saves it to `.kube/config`.
- How to use it:
  ```bash
  export KUBECONFIG=.kube/config
  kubectl get nodes
  kubectl get pods -A
  ```

### Usage 2: Merge globally into `~/.kube/config` (for global kubectl only)

```bash
bash scripts/kubeconfig.sh --merge
```
- Safely merges the `beluga` context into the host's `~/.kube/config`. (The existing `~/.kube/config` is automatically backed up to `~/.kube/config.bak.<timestamp>`.)
- How to use it:
  ```bash
  kubectl config use-context beluga
  kubectl get nodes
  kubectl get pods -A
  ```

---

## 4. Service URLs and Status

**Issue #2 (2026-08-26)**: The gateway (APISIX) serves HTTPS, and port 80 only redirects to 443
— `http://` URLs automatically switch to `https://` (the `redirect` plugin of `ApisixGlobalRule`,
`http_to_https: true`). Certificates are issued by the in-cluster CA (`beluga-internal-ca-issuer`, the
same self-signed CA already used by the Trino coordinator since Task 15) — **because this is not a
public CA, browsers display an "untrusted certificate" warning. This is normal behavior for an internal
cluster CA, not a bug.** To access it locally without warnings, import the CA certificate into the OS/browser trust store:

```bash
kubectl -n cert-manager get secret beluga-internal-ca-secret -o jsonpath='{.data.ca\.crt}' | base64 -d > beluga-ca.crt
# macOS: In the Keychain Access app, add beluga-ca.crt to the "System" keychain and set it to "Always Trust"
```

| Service | URL (HTTPS, internal CA) | Namespace | Notes |
|--------|---------------|--------------|------|
| Airflow 3 UI | `https://airflow.local.beluga.internal` | `orchestration` | |
| OpenMetadata | `https://metadata.local.beluga.internal` | `governance` | |
| Flink Dashboard | `https://flink.local.beluga.internal` | `streaming` | |
| SeaweedFS S3 | `https://s3.local.beluga.internal` | `storage` | |
| SSO Keycloak | `https://sso.local.beluga.internal` | `iam` | Redirects to the login page |
| ArgoCD UI | `https://argocd.local.beluga.internal` | `argocd` | |
| Lakekeeper REST | `https://catalog.local.beluga.internal` | `lakehouse` | |
| Superset BI | `https://superset.local.beluga.internal` | `analytics` | |
| Trino UI | `https://trino.local.beluga.internal` | `analytics` | OAuth2 login required (Task 16) |

The platform gateway (APISIX) and authentication backends (OPA/OpenFGA) are in `platform-system`, and PostgreSQL (CNPG) is in `database`.

---

## 5. Keycloak SSO User Login and Role Mapping

The Beluga platform provides single sign-on (SSO) based on Keycloak OIDC. The `beluga` Realm automatically creates three types of user account (Job `keycloak-users`), and each user's group controls platform-service permissions.

### SSO Service URLs
- **Keycloak SSO console**: `https://sso.local.beluga.internal` (Realm: `beluga`, switched to HTTPS in Issue #2)
- **Services that support OIDC login**: Superset (`https://superset.local.beluga.internal`), Airflow, OpenMetadata, Grafana
- **Trino has OAuth2 authentication enabled** (Task 16, D-E 2/2): self-asserting `X-Trino-User` is rejected with 401,
  and an actual Keycloak token is required. Authorization (group-based permissions) is enforced by the LDAP group provider (Task 13) +
  the OPA allow-by-role policy (Task 14).

### User Account and Group / Role Mapping

| Account (Username) | Email | Keycloak Group | Primary application role mapping (Role) |
|---------------|-------|--------------|----------------------|
| `beluga-admin` | `beluga-admin@beluga.local` | `admin` | **Superset Admin** / platform-wide administrator permissions |
| `beluga-engineer` | `beluga-engineer@beluga.local` | `engineer` | **Superset Alpha** (permission to create and edit datasets/pipelines) |
| `beluga-analyst` | `beluga-analyst@beluga.local` | `analyst` | **Superset Gamma** (dashboard/chart viewing and query-only access) |

> **Retrieve passwords**:
> `bash scripts/credentials.sh` shows each user's dynamically generated password.

---

## 6. How to Retrieve Service Credentials

Under the D15 specification, platform-service credentials are stored and managed in the `beluga-credentials` Secret in the `platform-system` namespace, or in service-specific Secrets.

### Recommended: Retrieve all at once

```bash
bash scripts/credentials.sh          # Print each service's URL, account, and password on one screen
bash scripts/credentials.sh --raw    # In key=value format (for scripts/pipes)
```

### Retrieve individually (without the script)

```bash
# Only one arbitrary key (pg-password, keycloak-admin-password, superset-admin-password,
#                         superset-secret-key, apisix-admin-key, client-secret-<app>)
kubectl -n platform-system get secret beluga-credentials -o jsonpath='{.data.<key>}' | base64 -d; echo

# ArgoCD admin initial password (separate Secret)
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo

# Airflow 3 standalone password (check in the pod log)
kubectl logs -n orchestration deployment/airflow-webserver | grep 'password'
```

### SeaweedFS Data-Plane Credentials/Bucket Policy

- The SeaweedFS S3 gateway renders three identities from the `storage/seaweedfs-s3-credentials` Secret: `trino-service`, `flink-service`, and `lakekeeper-service`.
- Each consumer reads only the dedicated Secret in its own namespace: `analytics/trino-s3-credential`, `streaming/flink-s3-credential`, and `lakehouse/lakekeeper-s3-credential`.
- There is currently one bucket, `beluga-lake`, and allowed actions are declared only in the `Action:beluga-lake` form. There are no global `Read`/`Write`/`List` permissions.
- Data-path convention:
  `raw/` is the CDC/ingestion landing area, `curated/` contains managed tables for analytics/modeling, and `tmp/` is for rewrites, checkpoints, and temporary outputs.
- This repository's SeaweedFS configuration uses only bucket-level action scopes. It does not enforce the `raw/`/`curated/`/`tmp/` prefixes themselves with ACLs; prefix-level enforcement is future work.

### SeaweedFS Credential Rotation/Retirement

1. Remove the two data keys, `seaweedfs-<identity>-access-key` and `seaweedfs-<identity>-secret-key`, for the target identity from `platform-system/beluga-credentials`. On the next bootstrap run, `ensure_cred` regenerates each with a new `openssl rand -hex 16` value. (Deleting only derived Secrets does not rotate them.)
2. Run `bash scripts/gitops/01-argocd-bootstrap.sh` to recreate `storage/seaweedfs-s3-credentials` and the corresponding consumer Secret with the new values.
3. Restart the `seaweedfs` StatefulSet and consumer workloads so they use the same identity: `storage/seaweedfs`, `analytics/trino-coordinator` (and `trino-worker` as well if used), the Flink session cluster/SQL submission Job in `streaming`, and `lakehouse/lakekeeper-bootstrap`.
4. If only retirement is needed, empty that identity's `credentials` array in `seaweedfs-s3-identities-template` and restart only `seaweedfs`. This retains the action definitions but removes only valid keys.

---

## 7. Troubleshooting Guide

If a domain cannot be accessed or an HTTP error occurs, check the cause with the step-by-step commands below.

### 7.1 Order for Checking Domain Access Issues

1. **Step 1: Check the host DNS Resolver**
   ```bash
   # Test the DNS query
   dig @192.168.77.10 sso.local.beluga.internal
   # Check host resolver configuration (macOS)
   scutil --dns | grep -A 5 "local.beluga.internal"
   ```

2. **Step 2: Check the Master-1 dnsmasq service status**
   ```bash
   vagrant ssh master-1 -c "sudo systemctl status dnsmasq"
   ```

3. **Step 3: Check CoreDNS Pod status**
   ```bash
   kubectl get pods -n kube-system -l k8s-app=kube-dns
   kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
   ```

4. **Step 4: Check the number and status of APISIX routes**
   ```bash
   # Check the number of routes registered in APISIX
   kubectl exec -n platform-system deployment/apisix -- curl -s http://127.0.0.1:9180/apisix/admin/routes | grep -c '"id"'
   ```

### 7.2 Causes and Actions by Major Symptom

| Symptom | Primary cause | Inspection and corrective action |
|------|-----------|-------------------|
| **000 (Connection Refused / Name Not Resolved)** | Host DNS resolution failure | Check whether `/etc/resolver/local.beluga.internal` exists and whether `nameserver 192.168.77.10` is registered. Check the master-1 DNS status with `systemctl status dnsmasq` |
| **HTTP 404 Not Found (all domains)** | Zero APISIX routes registered | ApisixRoute CRD not applied, or etcd / Ingress Controller synchronization failed. Check `kubectl get apisixroute -A` and `kubectl logs -n platform-system deployment/apisix-ingress-controller` |
| **HTTP 502 Bad Gateway** | Upstream Pod unhealthy | The backend Pod targeted by APISIX routing is down or unhealthy. Use `kubectl get pods -A -l app=<service-name>` to check the target Pod's namespace and CrashLoopBackOff or status (see §4 for service namespaces) |

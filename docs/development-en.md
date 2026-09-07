# Beluga Development Guide

## Prerequisites

Beluga requires Vagrant and the Vagrant provider selected by `scripts/up.sh`. Select VMware Fusion (arm64) or VirtualBox (amd64) with `VAGRANT_PROVIDER` in `configs/cluster.env`. The host also needs Vagrant, `kubectl`, and `helm`. The default configuration starts four VMs—`master-1` and `worker-1` to `worker-3`—so check the RAM and disk requirements in the README first.

## Start the cluster

Run this at the repository root:

```bash
bash scripts/up.sh
```

`scripts/up.sh` detects the RAM profile, starts Vagrant VMs, prepares nodes and initializes k3s, installs Cilium and MetalLB, configures local DNS, then bootstraps ArgoCD and GitOps. `make up` is a wrapper for this script.

## Isolate kubeconfig on a shared machine

This machine's kubeconfig is shared by concurrent sessions. Before working, make a temporary file containing only the `beluga` context and name it on **every** subsequent `kubectl` and `helm` invocation. Do not change the shared `~/.kube/config`.

```bash
kubectl --context=beluga config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
KUBECONFIG=/tmp/beluga-kubeconfig.yaml kubectl get nodes
KUBECONFIG=/tmp/beluga-kubeconfig.yaml helm list -A
```

If you need a repository-local kubeconfig, run `bash scripts/kubeconfig.sh` to create `.kube/config`. For cluster validation in the shared environment, the isolation rule above takes precedence.

## Tests

Run the full E2E bundle with:

```bash
bash tests/run-all.sh
# or make test
```

`run-all.sh` runs 01–05 and 07–12; 06 runs separately. The descriptions below are based on filenames only.

| Script | Filename-based subject |
|--------|------------------------|
| `01-cluster-health.sh` | Cluster health |
| `02-ingest-cdc.sh` | Ingest and CDC |
| `03-stream-iceberg.sh` | Stream and Iceberg |
| `04-trino-query.sh` | Trino queries |
| `05-airflow-dag.sh` | Airflow DAG |
| `06-authz-defaults.sh` | Default authorization — not included in `run-all.sh` |
| `07-trino-authz-live.sh` | Live Trino authorization |
| `08-apisix-admin-restrict.sh` | APISIX admin restriction |
| `09-seaweedfs-authz-live.sh` | Live SeaweedFS authorization |
| `10-tls-identity-boundary.sh` | TLS identity boundary |
| `11-identity-plaintext-preflight.sh` | Identity plaintext preflight |
| `12-gateway-route-consistency.sh` | Gateway route consistency |

## Branches and commits

Follow the rules in `CLAUDE.md`.

- Branch types are `feat/`, `fix/`, and `chore/`.
- Use Conventional Commits: `<type>(<module>): <desc>`.
- Allowed modules are `cluster`, `gitops`, `ingest`, `stream`, `lake`, `analytics`, `orch`, `demo`, and `docs`.
- Actual commit history also contains the additional prefixes `security(...)` and `test(...)`.
- **Local commits only; pushing is prohibited.**

There is currently no `.github/workflows` directory. Do not assume or document a CI/CD pipeline, PR review process, or release cadence that does not exist in this repository.

## GitOps and restart cautions

The `beluga-platform` and `beluga-data` ArgoCD Applications use `selfHeal: true`. A manual `kubectl apply` without a push can soon be reverted when it differs from GitOps state. The rule is to verify real application after a commit and push followed by ArgoCD synchronization; however, do not push outside this repository's local-commit-only policy without an explicit request.

Changing only a ConfigMap does not automatically restart the related Deployment. Explicitly run `kubectl rollout restart` for the required Deployment. For gateway or authentication changes, verify both direct component access and the actual entry path documented in the domain registry.

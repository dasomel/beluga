# Beluga on Kakao Cloud

English | [한국어](README.ko.md)

Deploys the Beluga platform (k3s + Cilium + ArgoCD GitOps) on Kakao Cloud with the same
topology as the Vagrant path: `master-1` (.10) + `worker-1..3` (.21-.23), profile 64.
**Status: applied live once (2026-10-16); see "Live verification".** Remaining unknowns are listed in
"First-apply risks".

```
internet ──► NLB (public IP) 80/443 ──► worker NodePort 31080/31443 ──► APISIX ──► services
operator ──► bastion (public IP, SSH from admin_cidrs only) ──► nodes (private, no public IP)
nodes ──► bastion squid :3128 ──► apt / GitHub / Helm / image registries
```

## Decisions

| ID | Decision | Reason / escape hatch |
|---|---|---|
| D1 | Private nodes; egress through a squid proxy on the bastion | The provider has no NAT resource, and a public IP per node would expose nodes. Escape hatch: give nodes public IPs and drop the proxy files from cloud-init (not implemented). |
| D2 | One NLB: TCP 80/443 to worker NodePorts 31080/31443; MetalLB skipped (`BELUGA_LB_MODE=nodeport`) | MetalLB L2 cannot ARP-advertise inside a VPC. |
| D3 | Code + static verification only | No credentials or real resources were used to produce this. |
| D-KAKAO-2 | `apisix-gateway` has a fixed ClusterIP `10.43.0.200`; dnsmasq answers `*.kakao.beluga.internal` with it | Inside the cluster and on nodes the domain resolves to the Service directly, so there is no hairpin through the public NLB IP. The `10.43.0.0/16` range is the k3s default (`02-k8s-init.sh` does not override it). Keep it equal to `apisix.service.clusterIP` in `gitops/charts/beluga-platform/values-kakao.yaml`. |
| D-KAKAO-3 | Root Application `beluga-root` uses two sources (`gitops/apps` minus `beluga-platform.yaml`/`app-of-apps.yaml`, plus `csp/kakao-cloud/gitops/apps`) | kustomize cannot reference plain files outside its root under ArgoCD's default load restrictor, and adding a kustomization to `gitops/apps` would change the default path. |

## Layout

- `terraform/` OpenTofu (provider `kakaoenterprise/kakaocloud` 0.5.1): `network`, `security`, `compute`, `loadbalancer` modules + root `bastion.tf`.
- `scripts/kakao-up.sh` bootstrap over the bastion; `scripts/kakao-kubeconfig.sh` fetches a repo-local kubeconfig.
- `gitops/` ArgoCD root app and the Kakao variant of `beluga-platform` (adds `values-kakao.yaml`).
- Shared parameterization (Vagrant defaults unchanged): `BELUGA_SRC`, `BELUGA_LB_MODE`, `METALLB_INTERFACE`, `UPSTREAM_DNS`, `BELUGA_PLATFORM_VALUES_EXTRA`, `BELUGA_APP_OF_APPS`, `/etc/beluga/cluster.override.env`, `/etc/default/beluga-proxy`.

## Workflow

Prerequisites: OpenTofu >= 1.13, `ssh`, `rsync`, `python3`, a Kakao Cloud application credential.

1. **Merge first.** ArgoCD tracks the default branch (`HEAD`) of `github.com/dasomel/beluga`; `values-kakao.yaml` and `csp/kakao-cloud/gitops` must be on it before step 4.
2. Configure and apply (this creates billable resources):
   ```bash
   cd csp/kakao-cloud/terraform
   cp terraform.tfvars.example terraform.tfvars   # set admin_cidrs; verify image/flavor names in the console
   export TF_VAR_application_credential_id=... TF_VAR_application_credential_secret=...
   tofu init && tofu plan && tofu apply
   ```
3. `bash csp/kakao-cloud/scripts/kakao-up.sh` (k3s, Cilium, dnsmasq/CoreDNS, ArgoCD; idempotent, safe to re-run).
4. `bash csp/kakao-cloud/scripts/kakao-kubeconfig.sh`, open the printed SSH tunnel, then `KUBECONFIG=.kube/kakao-config kubectl get nodes`. The Kubernetes API is never public.
5. Point the domains at the NLB: `<nlb_public_ip> trino airflow superset catalog s3 argocd sso` (each `.kakao.beluga.internal`; the Kakao platform domain is `kakao.beluga.internal` since 2026-10-17, Vagrant keeps `local.beluga.internal`) in `/etc/hosts`. The gateway keeps the cluster's self-signed internal CA, so trust it as on Vagrant.

Destroy: `tofu destroy`. If the VPC lingers in `PENDING_DELETE`, wait a few minutes before re-applying.

## Stable public IPs (D-KAKAO-12)

Verified live 2026-10-16 (see "Live verification"): the NIC survives bastion replacement and the public IP stays associated.

What is stable:

- Bastion: the public IP (`kakaocloud_public_ip.bastion`) is its own resource bound to a standalone NIC (`kakaocloud_network_interface.bastion`, fixed private IP). Replacing the VM keeps the NIC, so the public IP stays the same.
- Gateway NLB: the public IP (`module.loadbalancer.kakaocloud_public_ip.gateway`) is its own resource, so its address is stable, but it is NOT re-associated automatically after an NLB replacement (see below).
- Nodes have no public IP (D1: private nodes + bastion).

Both `public_ip` resources use `ignore_changes = [related_resource]`: when the device is replaced the provider would call detach on the deleted old device and fail the apply.

Bastion VM replacement:

```bash
tofu -chdir=csp/kakao-cloud/terraform apply -replace=kakaocloud_instance.bastion
tofu -chdir=csp/kakao-cloud/terraform apply -refresh-only   # then confirm outputs
tofu -chdir=csp/kakao-cloud/terraform output bastion_public_ip   # must equal the previous value
```

If the address changed or SSH fails, check in the console that the public IP is still attached to the bastion NIC (`bastion_network_interface_id` output); re-attach it there if not.

NLB replacement: the address is preserved but the new NLB has no public IP. After the apply, in the Kakao Cloud console re-associate the existing public IP (`tofu output nlb_public_ip`) to the new load balancer, then run `tofu apply -refresh-only`. Do not allocate a new IP.

`tofu destroy` releases both IPs. Before any `tofu destroy` that follows a replacement, run `tofu apply -refresh-only` first so `related_resource.device_id` in state is current (the provider's Delete calls RemovePublicIp with the state device_id).

To keep the IPs across a full destroy, remove them from state first, then import them BEFORE the next `tofu apply` so no new IP is allocated:

```bash
cd csp/kakao-cloud/terraform
tofu apply -refresh-only
tofu state rm kakaocloud_public_ip.bastion module.loadbalancer.kakaocloud_public_ip.gateway
tofu destroy
# next deployment: import the kept allocations first (public IP ids; import ID = the public IP UUID, verified live)
tofu import kakaocloud_public_ip.bastion <PUBLIC_IP_ID>
tofu import module.loadbalancer.kakaocloud_public_ip.gateway <PUBLIC_IP_ID>
tofu apply
```

Because `ignore_changes = [related_resource]` suppresses association of an imported IP, after the apply associate the kept IPs in the console (bastion IP -> `tofu output -raw bastion_network_interface_id`; NLB IP -> the new load balancer), run `tofu apply -refresh-only`, and verify SSH through the bastion. Alternative: temporarily remove `ignore_changes` for one apply. If `tofu import` fails because the config references not-yet-created resources, run `tofu apply -target=kakaocloud_instance.bastion -target=module.loadbalancer` first (unverified).

Migrating a stack applied before D-KAKAO-12: none exists in practice yet. If one did, applying this change replaces the bastion (subnets change); the old inline NIC is deleted with it and `ignore_changes` suppresses re-association. After the apply, in the console associate the existing bastion public IP to `tofu output -raw bastion_network_interface_id`, run `tofu apply -refresh-only`, and verify SSH via the bastion.

## Live verification (2026-10-16)

First real deployment: tofu 1.x, provider 0.5.1, `kr-central-2-a`, image `Ubuntu 24.04`, master `t1i.xlarge`, workers `t1i.2xlarge` x3.

- Bastion VM replaced twice with `tofu apply -replace=kakaocloud_instance.bastion`: public IP `210.109.61.102` unchanged, NIC preserved, `related_resource.device_id` followed after `tofu apply -refresh-only` (D-KAKAO-12 works).
- `tofu import <addr> <public_ip_id>` works (import ID = the public IP UUID).
- The NLB does not preserve client source IPs: external traffic reached the NodePorts under the VPC-only rule, so `nodeport_source_cidrs` needs no widening.
- Gateway through the NLB with the internal CA (`--cacert`): sso 302, argocd 200, trino 303, airflow 200, superset 302, catalog 308, s3 403; HTTP 80 -> 301. Direct NodePort from the bastion gives the same. Keycloak OIDC discovery 200 (realm `beluga`, master). In-cluster `sso.local.beluga.internal` -> 10.43.0.200 -> 200.
- All 19 `tests/*.sh` in `tests/run-all.sh` passed on Kakao.
- Bootstrap and convergence timings are in the measured table below. Keycloak crashloops until `postgres-main` exists, then converges to all apps Synced/Healthy.
- Destroy: `tofu apply -refresh-only`, then `tofu destroy` -> 0 resources left.

Fixes found by this run: D-KAKAO-13 (IGW + attachment; the provider does not attach one), D-KAKAO-14 (route table with 0.0.0.0/0 -> IGW; the default table only has the local route, so bastion SSH timed out), D-KAKAO-15 (dnsmasq `filter-AAAA` for squid; IPv6 answers gave CONNECT 503), bastion offset >= 11.

Second deployment (2026-10-16): the VPC DHCP DNS `169.254.169.253` timed out from every VM (dig and ping failed; SG egress and routes were fine, internet by IP worked; setting the public route table `is_main=true` did not help). cloud-init `packages` (squid, dnsmasq) failed on name resolution, so squid never ran and `kakao-up.sh` failed at the egress check. D-KAKAO-16: a bastion `bootcmd` writes `/etc/systemd/resolved.conf.d/beluga-upstream.conf` with `bastion_upstream_dns` (default `1.1.1.1 8.8.8.8`) before packages install; the VPC DNS stays listed, so dnsmasq's `resolv-file` carries all three. Cost: bastion queries also go to public resolvers; set `bastion_upstream_dns = []` to use the VPC DNS only. A `user_data` change does not replace an existing bastion: `tofu apply -replace=kakaocloud_instance.bastion`.

Measured deployment timing (second deployment, 2026-10-16 KST, profile 64, 1 master `t1i.xlarge` + 3 workers `t1i.2xlarge`, `kr-central-2-a`):

| Phase | Time | Duration |
|---|---|---|
| `tofu apply` (32 resources) | 09:19:24 -> 09:27:22 | ~8 min |
| `kakao-up.sh` run 1 (failed at egress check, VPC DNS timeout; D-KAKAO-16 diagnosis + manual bastion DNS workaround 09:28-09:37) | 09:27:33 -> 09:37 | ~9.5 min, excluded from the expected total |
| `kakao-up.sh` run 2 | 09:37:30 -> 09:58:35 | 21m05s |
| - 1/7 wait nodes | | 8s |
| - 2/7 rsync repo to `/opt/beluga` on all nodes | | 7m18s |
| - 3/7 node prep + k3s | | 56s |
| - 4/7 Cilium | | 1m11s |
| - 5/7 DNS (dnsmasq/split DNS) | | 1m40s |
| - 6/7 ArgoCD and GitOps bootstrap | | 9m52s |
| - 7/7 gateway check | | <1s |
| Convergence: all pods Ready 10:06:42; 3 ArgoCD apps Synced/Healthy 10:07:21 (`beluga-data` waits on the `flink-sql-submit` hook) | | ~8m46s after bootstrap |
| End to end (apply start -> fully converged) | | 47m57s wall clock; ~38 min without the DNS detour (expected for a fresh deployment) |

The two longest steps, rsync (~7 min) and the GitOps bootstrap (~10 min), are the optimization candidates.

Operational gotchas:

- Changing only `user_data` (e.g. `bastion_ip_offset`, proxy settings) does not replace instances (no plan diff). `-replace` the nodes explicitly.
- Replacing the bastion changes its SSH host key. Before re-running `kakao-up.sh`: `ssh-keygen -R <bastion_public_ip> -f csp/kakao-cloud/terraform/generated/known_hosts`.
- `tests/07` and `tests/10` resolve `*.${BASE_DOMAIN}` from the operator host (run them with `BASE_DOMAIN=kakao.beluga.internal` for Kakao; the default is `local.beluga.internal`). Because the two clusters now use different domains, a Vagrant entry no longer shadows Kakao; the names still have to point at the NLB public IP (or use `curl --resolve`).
- A main route table cannot be deleted ("Deleting the main VPC Route Table is not allowed"), and making a new table `is_main = true` did not move existing subnet associations. That is why the stack sets `route_table_id` on the subnets instead. Recovery if a table was made main by hand: set the VPC default table back to main first.

## Cost warning

Bastion + 1 master + 3 workers + NLB + public IPs + 100 GB boot volumes (default sizes: 4 vCPU/8 GiB master, 8 vCPU/16 GiB workers) bill continuously. Destroy when idle.

## Provider behaviors kept from earlier Kakao work

- A module-level `depends_on` defers that module's data sources to apply time, making image/flavor IDs unknown and forcing instance or LB replacement. Dependencies here are implicit (key name reference) or on the LB module only.
- The LB private VIP is auto-allocated and can steal a node's fixed IP, so the LB module depends on compute. The bastion IP is pinned (`bastion_ip_offset`) for the same reason.
- Security groups silently DROP unlisted ports (no reject): a slow timeout usually means a missing SG rule.
- No NAT gateway resource; destroyed VPC names can sit in `PENDING_DELETE`.

## First-apply risks and manual steps

1. **Flavor/image names** were verified live in one region/project (2026-10-16): defaults `t1i.xlarge` master, `t1i.2xlarge` workers, `Ubuntu 24.04`. Availability can differ per project/region; a 4 vCPU/16 GiB worker flavor would be the closest fit for profile 64. Plan fails with a precondition message if a name is missing.
2. **NLB source IP.** Verified live: the NLB does NOT preserve client IPs, so the VPC-only rule suffices. If that ever changes, traffic is dropped; widen only `nodeport_source_cidrs` to explicit ranges (0.0.0.0/0 and ::/0 are rejected; never cluster ports).
3. **Bastion IP offset** defaults to `.11`: `.5` was rejected live as Kakao-reserved (2026-10-16). The VPC needs an Internet Gateway for public IPs; the stack creates and attaches one (D-KAKAO-13).
4. **Image 24.04 vs the Vagrant 26.04 box**: scripts were exercised on 26.04 only.
5. **Verified live (2026-10-16)**: squid 443-only CONNECT, NodePort behind the NLB, `*.local.beluga.internal` -> ClusterIP resolution from pods, and gateway access both directly (NodePort) and through the NLB. Re-check the CONNECT policy when a new registry is added later.
6. Rendered `docs/` references to `apisix-gateway.yaml` line numbers shifted by the Service template change.
7. **Manager GitHub App Secret (ADR-0009 rollout 4)**: Secrets are not in Git and a fresh cluster does not have `manager-github-app` (`platform-system`; keys `app-id`, `installation-id`, `private-key.pem`). After every redeploy the owner re-creates it (`kubectl create secret generic manager-github-app -n platform-system --from-literal=app-id=... --from-literal=installation-id=... --from-file=private-key.pem=<path>`) and restarts `deployment/manager-domain-api`; until then SSO change submit answers 503 `GIT_WRITER_UNCONFIGURED`. Verify with `tests/25-manager-sso-github.sh`.

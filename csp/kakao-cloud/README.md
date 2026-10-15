# Beluga on Kakao Cloud

English | [한국어](README.ko.md)

Deploys the Beluga platform (k3s + Cilium + ArgoCD GitOps) on Kakao Cloud with the same
topology as the Vagrant path: `master-1` (.10) + `worker-1..3` (.21-.23), profile 64.
**Status: code and static checks only.** Nothing here has been applied to a real Kakao Cloud
project (see "First-apply risks").

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
| D-KAKAO-2 | `apisix-gateway` has a fixed ClusterIP `10.43.0.200`; dnsmasq answers `*.local.beluga.internal` with it | Inside the cluster and on nodes the domain resolves to the Service directly, so there is no hairpin through the public NLB IP. The `10.43.0.0/16` range is the k3s default (`02-k8s-init.sh` does not override it). Keep it equal to `apisix.service.clusterIP` in `gitops/charts/beluga-platform/values-kakao.yaml`. |
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
5. Point the domains at the NLB: `<nlb_public_ip> trino airflow superset catalog s3 argocd sso` (each `.local.beluga.internal`) in `/etc/hosts`. The gateway keeps the cluster's self-signed internal CA, so trust it as on Vagrant.

Destroy: `tofu destroy`. If the VPC lingers in `PENDING_DELETE`, wait a few minutes before re-applying.

## Stable public IPs (D-KAKAO-12)

**UNVERIFIED live:** that the NIC survives instance deletion and the association is kept has not been tested against a real apply. Static checks only.

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

`tofu destroy` releases both IPs. To keep them across a full destroy, remove them from state first and re-import later:

```bash
cd csp/kakao-cloud/terraform
tofu state rm kakaocloud_public_ip.bastion module.loadbalancer.kakaocloud_public_ip.gateway
tofu destroy
# next deployment, after the first apply creates new ones, replace them with the kept allocations:
tofu state rm kakaocloud_public_ip.bastion module.loadbalancer.kakaocloud_public_ip.gateway   # drop the new ones (release in console)
tofu import kakaocloud_public_ip.bastion <PUBLIC_IP_ID>
tofu import module.loadbalancer.kakaocloud_public_ip.gateway <PUBLIC_IP_ID>
```

(Verify the import ID format in the provider docs; it is not tested here. The kept IPs must still be unassociated or point at the deleted devices.)

## Cost warning

Bastion + 1 master + 3 workers + NLB + public IPs + 100 GB boot volumes (default sizes: 4 vCPU/8 GiB master, 8 vCPU/16 GiB workers) bill continuously. Destroy when idle.

## Provider behaviors kept from earlier Kakao work

- A module-level `depends_on` defers that module's data sources to apply time, making image/flavor IDs unknown and forcing instance or LB replacement. Dependencies here are implicit (key name reference) or on the LB module only.
- The LB private VIP is auto-allocated and can steal a node's fixed IP, so the LB module depends on compute. The bastion IP is pinned (`bastion_ip_offset`) for the same reason.
- Security groups silently DROP unlisted ports (no reject): a slow timeout usually means a missing SG rule.
- No NAT gateway resource; destroyed VPC names can sit in `PENDING_DELETE`.

## First-apply risks and manual steps

1. **Flavor/image names are unverified.** Defaults (`t1i.xlarge` master, `t1i.2xlarge` workers, `Ubuntu 24.04`) follow naming seen in other projects; a 4 vCPU/16 GiB worker flavor would be the closest fit for profile 64. Plan fails with a precondition message if a name is missing.
2. **NLB source IP.** SG ingress for 31080/31443 is the VPC CIDR. If the NLB preserves client IPs, traffic is dropped; widen only `nodeport_source_cidrs` to explicit ranges (0.0.0.0/0 and ::/0 are rejected; never cluster ports).
3. **Bastion IP offset** (`.5`) may fall in Kakao's reserved low range; change `bastion_ip_offset` if the instance fails to create.
4. **Image 24.04 vs the Vagrant 26.04 box**: scripts were exercised on 26.04 only.
5. **Not verified live**: squid CONNECT/443-only policy against every registry, Cilium NodePort behind the NLB, `*.local.beluga.internal` -> ClusterIP resolution from pods, the in-cluster DNS test pod pulling `busybox` through the proxy. Verify gateway access both directly (NodePort) and through the NLB (`tests/` live suite, `docs/access-guide.md`).
6. Rendered `docs/` references to `apisix-gateway.yaml` line numbers shifted by the Service template change.

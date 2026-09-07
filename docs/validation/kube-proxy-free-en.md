# Kube-proxy-free Validation

Beluga uses Cilium for the Service datapath without K3s Flannel, ServiceLB, or kube-proxy.

## Architecture

K3s: Flannel disabled; ServiceLB disabled; kube-proxy disabled; Cilium kubeProxyReplacement=true; eBPF Service Load Balancing.

MetalLB provides external IPs for type LoadBalancer Services, while APISIX handles HTTP entry points. Do not confuse their roles.

## Post-deployment validation

```bash
# 1. Cilium이 정상 동작하는지 확인
kubectl -n kube-system get pods -l k8s-app=cilium -o wide

# 2. kube-proxy가 없어야 한다
kubectl get pods -A -o wide | grep -E '(^|[[:space:]])kube-proxy(-|[[:space:]])' || true

# 3. K3s ServiceLB(svclb-*)가 없어야 한다
kubectl get pods -A -o wide | grep -E '(^|[[:space:]])svclb-' || true

# 4. Cilium kube-proxy replacement 설정 확인
kubectl -n kube-system get ds cilium -o yaml | grep -E 'kube-proxy-replacement|kubeProxyReplacement' -C 2

# 5. Service / EndpointSlice 확인
kubectl get svc -A
kubectl get endpointslice -A -o wide
```

## Expected state

- kube-proxy Pods: **0**
- svclb-* Pods: **0**
- Cilium DaemonSet: Ready on every Node
- ClusterIP/NodePort/LoadBalancer Service datapath: **Cilium eBPF**
- MetalLB: external LoadBalancer IP assignment only
- APISIX: HTTP Gateway/Ingress role

## Service LB behavior validation

Place two or more Pods behind the same Service, add Pod name/IP response headers, and call repeatedly.

```bash
for i in $(seq 1 30); do
  curl -sS -D - http://<service-address>/ -o /dev/null \
    | grep -Ei 'X-Pod-Name|X-Pod-IP|X-Node-Name'
done
```

Distinguish **HTTP request count from TCP connection count**. Keep-alive can send multiple requests to one backend, so also test new connections. Do not expect fixed A/B/A/B ordering like IPVS rr; observe Cilium eBPF backend selection and record its version/configuration.

## Automated validation

make test includes tests/01-cluster-health.sh, which checks four Ready Nodes, Running/Completed system Pods, Cilium Pods, and no kube-proxy Pods. Future K3s/Cilium changes that re-enable kube-proxy therefore fail the basic E2E stage.

## Revalidation checklist

```text
[ ] make up
[ ] make test
[ ] kube-proxy Pod = 0
[ ] svclb-* Pod = 0
[ ] Cilium Ready
[ ] Check Cilium kube-proxy replacement
[ ] Check Service/EndpointSlice
[ ] 30-call Service LB distribution test
[ ] Check the MetalLB LoadBalancer IP
[ ] Check APISIX HTTP access
```

Changes not tested through a live Vagrant/K3s restart remain post-deployment procedures and must be checked on the next clean-cluster start.


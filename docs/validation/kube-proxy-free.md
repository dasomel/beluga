# Kube-proxy-free 검증

Beluga는 K3s의 Flannel, ServiceLB, kube-proxy를 사용하지 않고 Cilium이 Service datapath를 전담하는 구성을 사용한다.

## 아키텍처

```text
K3s
 ├─ Flannel        disabled
 ├─ ServiceLB      disabled
 ├─ kube-proxy     disabled
 └─ Cilium
      └─ kubeProxyReplacement=true
           └─ eBPF Service Load Balancing
```

MetalLB는 `type: LoadBalancer` Service에 외부 IP를 제공하고, HTTP 진입점은 APISIX가 담당한다. 따라서 MetalLB와 Cilium의 역할을 혼동하지 않는다.

## 배포 후 검증

클러스터 기동 후 다음을 순서대로 확인한다.

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

## 기대 상태

- `kube-proxy` Pod: **0개**
- `svclb-*` Pod: **0개**
- Cilium DaemonSet: 모든 Node에서 `Ready`
- ClusterIP/NodePort/LoadBalancer Service datapath: **Cilium eBPF**
- MetalLB: 외부 LoadBalancer IP 할당만 담당
- APISIX: HTTP Gateway/Ingress 역할 담당

## Service LB 동작 검증

동일 Service에 2개 이상의 Pod를 배치하고 응답 헤더에 Pod 이름/IP를 넣은 뒤 반복 호출한다.

```bash
for i in $(seq 1 30); do
  curl -sS -D - http://<service-address>/ -o /dev/null \
    | grep -Ei 'X-Pod-Name|X-Pod-IP|X-Node-Name'
done
```

검증 시 **HTTP 요청 수와 TCP 연결 수를 구분**한다. Keep-alive 연결에서는 여러 요청이 같은 backend로 전달될 수 있으므로, LB 분포를 검증할 때는 새 연결을 생성하는 테스트도 함께 수행한다.

IPVS의 `rr`처럼 요청 순서가 A/B/A/B로 고정된다고 기대하지 않는다. Cilium eBPF Service LB의 실제 backend selection 결과를 관찰하고, 사용 중인 Cilium 버전과 설정을 함께 기록한다.

## 자동 검증

`make test`에 포함된 `tests/01-cluster-health.sh`는 다음을 자동 확인한다.

- 4개 Node가 Ready인지
- 시스템 Pod가 Running/Completed인지
- Cilium Pod가 존재하는지
- kube-proxy Pod가 존재하지 않는지

따라서 이후 K3s/Cilium 변경 시 kube-proxy가 다시 활성화되면 기본 E2E 단계에서 즉시 실패하도록 한다.

## 재검증 시 체크리스트

```text
[ ] make up
[ ] make test
[ ] kube-proxy Pod = 0
[ ] svclb-* Pod = 0
[ ] Cilium Ready
[ ] Cilium kube-proxy replacement 확인
[ ] Service/EndpointSlice 확인
[ ] 30회 Service LB 분포 테스트
[ ] MetalLB LoadBalancer IP 확인
[ ] APISIX HTTP 접근 확인
```

현재 저장소에서 라이브 Vagrant/K3s 재기동을 수행하지 못한 변경은 문서의 배포 후 검증 절차로 남기며, 다음 클린 클러스터 기동 시 반드시 위 검증을 수행한다.

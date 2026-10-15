# Security module — 노드 보안그룹.
#
# D-SG-1: 노드에는 0.0.0.0/0 ingress 가 없다. SSH 는 bastion /32 에서만, 클러스터 포트는 VPC(또는
#         서브넷) 대역에서만, 게이트웨이 NodePort 는 nodeport_source_cidrs 에서만 연다.
# 문서화된 제공자 동작: Kakao SG 는 허용되지 않은 포트를 거부(REJECT)하지 않고 조용히 DROP 한다.
#   → 연결이 즉시 실패하지 않고 타임아웃으로 멈춘다. 증상이 "느린 실패"면 먼저 여기 규칙 누락을 의심한다
#   (예: 크로스노드 Prometheus 스크레이프가 context deadline exceeded 로 끝나는 경우).

locals {
  # 포트 하나당 규칙 하나: 아래 for 식이 gateway NodePort × source CIDR 조합을 펼친다.
  gateway_rules = flatten([
    for port in var.gateway_node_ports : [
      for cidr in var.nodeport_source_cidrs : {
        direction        = "ingress"
        protocol         = "TCP"
        port_range_min   = port
        port_range_max   = port
        remote_ip_prefix = cidr
        description      = "APISIX gateway NodePort ${port} (NLB)"
      }
    ]
  ])
}

resource "kakaocloud_security_group" "node" {
  name        = var.security_group_name
  description = "Beluga cluster nodes (Terraform managed) - no public ingress"

  rules = concat([
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 22
      port_range_max   = 22
      remote_ip_prefix = "${var.bastion_private_ip}/32"
      description      = "SSH from bastion only"
    },
    # k3s API (워커 join, Cilium k8sServiceHost, kubectl 터널은 bastion→master:22 로 가므로 불필요)
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 6443
      port_range_max   = 6443
      remote_ip_prefix = var.vpc_cidr
      description      = "Kubernetes API (internal)"
    },
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 10250
      port_range_max   = 10250
      remote_ip_prefix = var.subnet_cidr
      description      = "Kubelet API (internal, node subnet only)"
    },
    # Cilium
    {
      direction        = "ingress"
      protocol         = "UDP"
      port_range_min   = 8472
      port_range_max   = 8472
      remote_ip_prefix = var.vpc_cidr
      description      = "Cilium VXLAN overlay (internal)"
    },
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 4240
      port_range_max   = 4240
      remote_ip_prefix = var.vpc_cidr
      description      = "Cilium health check (internal)"
    },
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 4244
      port_range_max   = 4245
      remote_ip_prefix = var.vpc_cidr
      description      = "Cilium Hubble relay/server (internal)"
    },
    # master-1 의 dnsmasq(10-dnsmasq.sh): 워커 systemd-resolved 와 CoreDNS(파드, 노드 IP 로 SNAT)가
    # *.local.beluga.internal 을 여기로 질의한다. UDP 는 거의 모든 질의, TCP 는 512B 초과 응답.
    {
      direction        = "ingress"
      protocol         = "UDP"
      port_range_min   = 53
      port_range_max   = 53
      remote_ip_prefix = var.vpc_cidr
      description      = "dnsmasq split DNS on master (internal)"
    },
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 53
      port_range_max   = 53
      remote_ip_prefix = var.vpc_cidr
      description      = "dnsmasq split DNS on master TCP (internal)"
    },
    # prometheus-grafana 가 기본 활성(values.yaml)이라 node-exporter(hostNetwork :9100)를 노드 간 스크레이프한다.
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 9100
      port_range_max   = 9100
      remote_ip_prefix = var.vpc_cidr
      description      = "Prometheus node-exporter (internal)"
    },
    {
      direction        = "ingress"
      protocol         = "ICMP"
      remote_ip_prefix = var.vpc_cidr
      description      = "ICMP from VPC"
    },
    ], local.gateway_rules, [
    {
      direction        = "egress"
      protocol         = "ALL"
      remote_ip_prefix = "0.0.0.0/0"
      description      = "All outbound traffic"
    }
  ])
}

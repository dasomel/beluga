# Beluga on Kakao Cloud — VPC, 보안그룹, VM(master-1 + worker-N), NLB, bastion.
# k3s/Cilium/플랫폼 설치는 apply 이후 csp/kakao-cloud/scripts/kakao-up.sh 가 담당한다.
#
# 결정 기록
#   D1 Egress : 노드는 사설 전용(공인 IP 없음). apt/GitHub/Helm/이미지 레지스트리는 bastion 의 squid 경유.
#   D2 Gateway: Kakao NLB(공인 IP) 80/443 → 워커 NodePort 31080/31443 → APISIX. MetalLB 는 클라우드에서 생략.
#   D3 Scope  : 이 코드는 정적 검증(tofu validate/fmt)만 거쳤다. 실제 apply 는 README 의 절차대로 수동.

locals {
  vpc_cidr_effective = module.network.vpc_cidr

  # 노드 사설 IP 를 plan 시점에 확정(cidrhost) → 프록시 주소도 bastion 리소스에 의존하지 않고 계산한다.
  bastion_private_ip = cidrhost(var.subnet_cidr, var.bastion_ip_offset)
  proxy_url          = "http://${local.bastion_private_ip}:3128"

  # 프록시를 타면 안 되는 목적지: VPC(노드 간·bastion), 파드/서비스 CIDR, 클러스터 DNS 접미사, 루프백,
  # 플랫폼 도메인(dnsmasq 가 내부 ClusterIP 로 푼다). 빠지면 클러스터 내부 트래픽이 bastion 으로 샌다.
  no_proxy = join(",", [
    var.vpc_cidr,
    var.pod_cidr,
    var.service_cidr,
    ".svc",
    ".cluster.local",
    "localhost",
    "127.0.0.1",
    var.base_domain,
    ".${var.base_domain}",
  ])

  nodeport_source_cidrs = var.nodeport_source_cidrs != null ? var.nodeport_source_cidrs : [var.vpc_cidr]
}

#####################################################################
# Module 1: Network
#####################################################################
module "network" {
  source = "./modules/network"

  vpc_name                = "${var.name_prefix}-vpc"
  vpc_cidr                = var.vpc_cidr
  vpc_default_subnet_cidr = var.vpc_default_subnet_cidr
  subnet_name             = "${var.name_prefix}-subnet"
  subnet_cidr             = var.subnet_cidr
  availability_zone       = var.availability_zone
}

#####################################################################
# Module 2: Security (node SG)
#####################################################################
module "security" {
  source = "./modules/security"

  security_group_name   = "${var.name_prefix}-node-sg"
  vpc_cidr              = module.network.vpc_cidr
  subnet_cidr           = module.network.subnet_cidr
  bastion_private_ip    = local.bastion_private_ip
  gateway_node_ports    = [var.gateway_http_node_port, var.gateway_https_node_port]
  nodeport_source_cidrs = local.nodeport_source_cidrs
}

#####################################################################
# Keypair (생성 키는 generated/ 에 0600, gitignore)
#####################################################################
resource "tls_private_key" "ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "kakaocloud_keypair" "ssh" {
  name       = var.key_name
  public_key = tls_private_key.ssh.public_key_openssh
}

resource "local_sensitive_file" "ssh_key" {
  content         = tls_private_key.ssh.private_key_pem
  filename        = var.ssh_key_path
  file_permission = "0600"
}

#####################################################################
# Module 3: Compute
#####################################################################
module "compute" {
  source = "./modules/compute"

  name_prefix   = var.name_prefix
  worker_count  = var.worker_count
  image_name    = var.image_name
  master_flavor = var.master_flavor
  worker_flavor = var.worker_flavor
  volume_size   = var.volume_size
  # key_name 을 키페어 리소스 참조로 넘겨 암묵 의존만 만든다. module-level depends_on 은 쓰지 않는다:
  # 모듈 depends_on 은 의존 대상에 변경이 있으면 이 모듈의 data source(images/flavors)를 apply 시점으로
  # 미뤄 image_id 를 unknown 으로 만들고, 보안그룹 규칙 하나만 바뀌어도 모든 인스턴스가 "교체 필요"가 된다.
  key_name            = kakaocloud_keypair.ssh.name
  subnet_id           = module.network.subnet_id
  subnet_cidr         = var.subnet_cidr
  security_group_name = module.security.security_group_name

  cloud_init_vars = {
    vpc_cidr          = var.vpc_cidr
    proxy_url         = local.proxy_url
    no_proxy          = local.no_proxy
    apisix_cluster_ip = var.apisix_cluster_ip
    base_domain       = var.base_domain
  }
}

#####################################################################
# Module 4: Load balancer (단일 NLB)
#####################################################################
# 루트에서 조회한다: 모듈 depends_on 아래의 data source 는 apply 시점으로 밀려 flavor_id 가 unknown
# 이 되고 LB 교체를 강제한다.
data "kakaocloud_load_balancer_flavors" "all" {}

locals {
  lb_flavor_nlb_id = one([
    for f in data.kakaocloud_load_balancer_flavors.all.flavors : f.id
    if f.name == "NLB"
  ])
}

module "loadbalancer" {
  source = "./modules/loadbalancer"

  lb_name            = "${var.name_prefix}-gateway-lb"
  lb_flavor_id       = local.lb_flavor_nlb_id
  availability_zone  = var.availability_zone
  subnet_id          = module.network.subnet_id
  worker_private_ips = module.compute.worker_private_ips
  http_node_port     = var.gateway_http_node_port
  https_node_port    = var.gateway_https_node_port

  # LB 는 노드보다 뒤에 만든다. kakaocloud_load_balancer 의 private_vip 는 서브넷에서 자동 할당되고
  # (고정 불가), LB 가 먼저 생기면 compute 가 고정해 둔 노드 IP 를 가져가 인스턴스가
  # "Fixed IP address ... is already in use" 로 죽는다(이전 Kakao 프로젝트 2026-07-26 실측). 이 depends_on 이 그 순서를 만든다.
  depends_on = [module.compute]
}

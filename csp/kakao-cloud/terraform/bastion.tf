# Bastion — SSH 점프 호스트 + squid 포워드 프록시 (D1). 클러스터 서브넷에 고정 IP.
# 노드는 공인 IP가 없으므로 관리 SSH 와 모든 외부 egress 가 이 한 곳을 거친다.
resource "kakaocloud_security_group" "bastion" {
  name        = "${var.name_prefix}-bastion-sg"
  description = "Beluga bastion - SSH from operator CIDRs only; squid for VPC only"

  rules = concat([
    for cidr in var.admin_cidrs : {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 22
      port_range_max   = 22
      remote_ip_prefix = cidr
      description      = "SSH (operator-restricted)"
    }
    ], [
    {
      direction        = "ingress"
      protocol         = "TCP"
      port_range_min   = 3128
      port_range_max   = 3128
      remote_ip_prefix = var.vpc_cidr
      description      = "Forward proxy (squid), VPC only"
    },
    {
      direction        = "egress"
      protocol         = "ALL"
      remote_ip_prefix = "0.0.0.0/0"
      description      = "All outbound traffic"
    }
  ])
}

data "kakaocloud_images" "bastion_image" {}
data "kakaocloud_instance_flavors" "bastion_flavors" {}

locals {
  bastion_image_id = one([
    for image in data.kakaocloud_images.bastion_image.images : image.id
    if image.name == var.image_name
  ])

  bastion_flavor_id = one([
    for flavor in data.kakaocloud_instance_flavors.bastion_flavors.instance_flavors : flavor.id
    if flavor.name == var.bastion_flavor
  ])
}

# D-KAKAO-12: 공인 IP 고정. 사설 IP·SG 를 가진 NI 를 인스턴스와 분리해 별도 리소스로 둔다.
#  - 이유: floating IP 는 NI 에 묶이므로, VM 만 교체돼도(NI 유지) 연결이 남아 같은 공인 IP 로 돌아온다.
#  - 비용: 인스턴스 생성이 기존 NI 를 쓰는 경로(subnets.network_interface_id)에 의존한다. NI 가 인스턴스
#    삭제 때 같이 지워지는지는 라이브 미검증(README "공인 IP 고정").
#  - 탈출구: NI 를 지우거나 private_ip 를 바꾸면 NI 가 교체되어 연결도 끊긴다. 원복은 이 블록을 지우고
#    인스턴스에 inline private_ip 를 되돌린다.
resource "kakaocloud_network_interface" "bastion" {
  name        = "${var.name_prefix}-bastion-nic"
  description = "Beluga bastion fixed NIC (private IP + public IP binding survive VM replacement)"
  subnet_id   = module.network.subnet_id
  private_ip  = local.bastion_private_ip

  security_groups = [{
    id = kakaocloud_security_group.bastion.id
  }]
}

resource "kakaocloud_instance" "bastion" {
  name        = "${var.name_prefix}-bastion"
  description = "Beluga bastion (SSH jump host + squid proxy)"
  flavor_id   = local.bastion_flavor_id
  image_id    = local.bastion_image_id
  key_name    = kakaocloud_keypair.ssh.name

  # 고정 IP: 노드의 프록시 주소(cloud-init)가 이 값이라, 교체돼도 같은 주소로 돌아와야 한다.
  # 사설 IP 는 별도 NI(위)가 가진다 — 인스턴스는 그 NI 를 붙이기만 한다(D-KAKAO-12).
  subnets = [{
    id                   = module.network.subnet_id
    network_interface_id = kakaocloud_network_interface.bastion.id
  }]

  # initial_security_groups 는 쓰지 않는다: 기존 NI 를 붙이면 provider 가 함께 지정을 거부한다. SG 는 NI 가 가진다.

  volumes = [{ size = var.bastion_volume_size }]

  user_data = base64encode(templatefile("${path.module}/templates/cloud-init-bastion.yaml.tftpl", {
    vpc_cidr = var.vpc_cidr
  }))

  lifecycle {
    precondition {
      condition     = local.bastion_flavor_id != null && local.bastion_image_id != null
      error_message = "bastion_flavor / image_name not found in this project — verify the names in the Kakao Cloud console."
    }
  }
}

# D-KAKAO-12: 공인 IP 할당은 인스턴스 수명과 독립된 리소스다. related_resource 는 NI 를 가리키며
# NI 는 VM 교체 후에도 남으므로 연결이 유지된다. ignore_changes 이유: 교체로 instance.id 가 바뀌면
# provider 가 삭제된 옛 장치에 detach 를 호출해 apply 가 실패한다(in-place detach+재연결, RequiresReplace 없음).
# 비용: 연결 대상이 실제로 어긋나도 plan 에 안 보인다 — `tofu apply -refresh-only` 로 확인(README).
resource "kakaocloud_public_ip" "bastion" {
  description = "Public IP for the Beluga bastion"

  related_resource = {
    device_id   = kakaocloud_instance.bastion.id
    device_type = "instance"
    id          = kakaocloud_network_interface.bastion.id
  }

  lifecycle {
    ignore_changes = [related_resource]
  }

  # D-KAKAO-13: IGW 가 붙은 뒤에만 연결할 수 있다.
  depends_on = [module.network]
}

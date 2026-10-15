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

resource "kakaocloud_instance" "bastion" {
  name        = "${var.name_prefix}-bastion"
  description = "Beluga bastion (SSH jump host + squid proxy)"
  flavor_id   = local.bastion_flavor_id
  image_id    = local.bastion_image_id
  key_name    = kakaocloud_keypair.ssh.name

  # 고정 IP: 노드의 프록시 주소(cloud-init)가 이 값이라, 교체돼도 같은 주소로 돌아와야 한다.
  subnets = [{
    id         = module.network.subnet_id
    private_ip = local.bastion_private_ip
  }]

  initial_security_groups = [{
    name = kakaocloud_security_group.bastion.name
  }]

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

resource "kakaocloud_public_ip" "bastion" {
  description = "Public IP for the Beluga bastion"

  related_resource = {
    device_id   = kakaocloud_instance.bastion.id
    device_type = "instance"
    id          = kakaocloud_instance.bastion.addresses[0].network_interface_id
  }
}

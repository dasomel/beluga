# Compute module — master-1 + worker-1..N (Vagrant 토폴로지와 동일, 고정 사설 IP).

data "kakaocloud_images" "images_all" {}
data "kakaocloud_instance_flavors" "flavors_all" {}

locals {
  image_id = one([
    for image in data.kakaocloud_images.images_all.images : image.id
    if image.name == var.image_name
  ])

  master_flavor_id = one([
    for flavor in data.kakaocloud_instance_flavors.flavors_all.instance_flavors : flavor.id
    if flavor.name == var.master_flavor
  ])

  worker_flavor_id = one([
    for flavor in data.kakaocloud_instance_flavors.flavors_all.instance_flavors : flavor.id
    if flavor.name == var.worker_flavor
  ])

  # 고정 연속 IP: master-1=.10, worker-1..3=.21-.23 → Vagrant 의 MASTER_IP/WORKER*_IP 규칙과 같다.
  master_ip  = cidrhost(var.subnet_cidr, var.master_ip_offset)
  worker_ips = [for i in range(var.worker_count) : cidrhost(var.subnet_cidr, var.worker_ip_offset + i)]

  # cloud-init 은 노드별로 렌더한다(ROLE/NODE_NAME/NODE_IP 가 /etc/beluga/node.env 로 들어간다).
  master_user_data = base64encode(templatefile("${path.module}/templates/cloud-init-node.yaml.tftpl", merge(var.cloud_init_vars, {
    role      = "master"
    node_name = "master-1"
    node_ip   = local.master_ip
    master_ip = local.master_ip
  })))
  worker_user_data = [for i in range(var.worker_count) : base64encode(templatefile("${path.module}/templates/cloud-init-node.yaml.tftpl", merge(var.cloud_init_vars, {
    role      = "worker"
    node_name = "worker-${i + 1}"
    node_ip   = local.worker_ips[i]
    master_ip = local.master_ip
  })))]
}

resource "kakaocloud_instance" "master" {
  name        = "${var.name_prefix}-master-1"
  description = "Beluga master node (k3s server)"
  flavor_id   = local.master_flavor_id
  image_id    = local.image_id
  key_name    = var.key_name

  subnets = [{ id = var.subnet_id, private_ip = local.master_ip }]

  initial_security_groups = [{
    name = var.security_group_name
  }]

  volumes   = [{ size = var.volume_size }]
  user_data = local.master_user_data

  lifecycle {
    precondition {
      condition     = local.master_flavor_id != null && local.image_id != null
      error_message = "master_flavor / image_name not found in this project — verify the names in the Kakao Cloud console."
    }
  }
}

resource "kakaocloud_instance" "worker" {
  count       = var.worker_count
  name        = "${var.name_prefix}-worker-${count.index + 1}"
  description = "Beluga worker node (k3s agent)"
  flavor_id   = local.worker_flavor_id
  image_id    = local.image_id
  key_name    = var.key_name

  subnets = [{ id = var.subnet_id, private_ip = local.worker_ips[count.index] }]

  initial_security_groups = [{
    name = var.security_group_name
  }]

  volumes   = [{ size = var.volume_size }]
  user_data = local.worker_user_data[count.index]

  lifecycle {
    precondition {
      condition     = local.worker_flavor_id != null && local.image_id != null
      error_message = "worker_flavor / image_name not found in this project — verify the names in the Kakao Cloud console."
    }
  }
}

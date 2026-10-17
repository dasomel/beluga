# kakao-up.sh / kakao-kubeconfig.sh 는 `tofu output -json` 의 아래 값을 읽는다.

output "bastion_public_ip" {
  description = "Bastion public IP (the only SSH entry point)"
  value       = kakaocloud_public_ip.bastion.public_ip
}

output "bastion_private_ip" {
  description = "Bastion private IP (squid proxy address used by the nodes)"
  value       = local.bastion_private_ip
}

output "bastion_network_interface_id" {
  description = "Bastion fixed NIC id (the public IP binds to this; survives VM replacement, D-KAKAO-12)"
  value       = kakaocloud_network_interface.bastion.id
}

output "nlb_public_ip" {
  description = "Gateway NLB public IP — point *.<base_domain> here (scripts/hosts.sh / /etc/hosts)"
  value       = module.loadbalancer.lb_public_ip
}

output "nlb_private_vip" {
  description = "Gateway NLB private VIP"
  value       = module.loadbalancer.lb_private_vip
}

output "master_private_ip" {
  description = "master-1 private IP"
  value       = module.compute.master_private_ip
}

output "worker_private_ips" {
  description = "Worker private IPs (worker-1..N)"
  value       = module.compute.worker_private_ips
}

output "ssh_key_path" {
  description = "Generated private key path"
  value       = var.ssh_key_path
}

output "proxy_url" {
  description = "Forward proxy URL configured on the nodes"
  value       = local.proxy_url
}

output "apisix_cluster_ip" {
  description = "Fixed ClusterIP of apisix-gateway (dnsmasq answer for *.base_domain)"
  value       = var.apisix_cluster_ip
}

output "base_domain" {
  description = "Platform base domain"
  value       = var.base_domain
}

locals {
  # 호스트 키는 클러스터 전용 파일에 고정한다(~/.ssh/known_hosts 오염·IP 재사용 충돌 방지).
  # accept-new: 첫 접속 때 고정하고, 이후 키가 바뀌면 실패(fail closed). 노드를 의도적으로 재생성했다면
  # `ssh-keygen -R <ip> -f generated/known_hosts` 로 해당 핀만 지운다 — StrictHostKeyChecking=no 로 우회하지 않는다.
  ssh_key_abs      = abspath(var.ssh_key_path)
  known_hosts_abs  = "${dirname(abspath(var.ssh_key_path))}/known_hosts"
  ssh_common_opts  = "-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${local.known_hosts_abs} -o LogLevel=ERROR"
  bastion_proxycmd = "ssh -F /dev/null -i ${local.ssh_key_abs} ${local.ssh_common_opts} -W %h:%p ubuntu@${kakaocloud_public_ip.bastion.public_ip}"
}

output "ssh_config" {
  description = "ssh_config for the bastion and nodes. Nodes use ProxyCommand through the bastion (not -J: ProxyJump does not carry the identity/known_hosts options to the jump hop)."
  value       = <<-EOT
    Host *
      User ubuntu
      IdentityFile ${local.ssh_key_abs}
      IdentitiesOnly yes
      StrictHostKeyChecking accept-new
      UserKnownHostsFile ${local.known_hosts_abs}
      LogLevel ERROR

    Host beluga-bastion
      HostName ${kakaocloud_public_ip.bastion.public_ip}

    Host master-1
      HostName ${module.compute.master_private_ip}
      ProxyCommand ${local.bastion_proxycmd}
    %{for i, ip in module.compute.worker_private_ips~}

    Host worker-${i + 1}
      HostName ${ip}
      ProxyCommand ${local.bastion_proxycmd}
    %{endfor~}
  EOT
}

output "next_steps" {
  description = "What to run after apply"
  value       = <<-EOT
    1. bash csp/kakao-cloud/scripts/kakao-up.sh        # k3s + Cilium + ArgoCD bootstrap over the bastion
    2. bash csp/kakao-cloud/scripts/kakao-kubeconfig.sh  # repo-local .kube/kakao-config + SSH tunnel hint
    3. /etc/hosts: ${module.loadbalancer.lb_public_ip}  <domain>.${var.base_domain}  (see README)
  EOT
}

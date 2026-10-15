output "lb_private_vip" {
  description = "NLB private VIP"
  value       = kakaocloud_load_balancer.gateway.private_vip
}

output "lb_public_ip" {
  description = "NLB public IP (point *.local.beluga.internal here in /etc/hosts)"
  value       = kakaocloud_public_ip.gateway.public_ip
}

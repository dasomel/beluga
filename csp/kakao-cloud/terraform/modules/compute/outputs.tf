output "master_private_ip" {
  description = "master-1 private IP"
  value       = kakaocloud_instance.master.addresses[0].private_ip
}

output "worker_private_ips" {
  description = "Worker private IPs (worker-1..N)"
  value       = [for instance in kakaocloud_instance.worker : instance.addresses[0].private_ip]
}

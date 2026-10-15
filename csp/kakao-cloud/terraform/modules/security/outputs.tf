output "security_group_id" {
  description = "Node security group ID"
  value       = kakaocloud_security_group.node.id
}

output "security_group_name" {
  description = "Node security group name"
  value       = kakaocloud_security_group.node.name
}

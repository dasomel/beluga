output "vpc_id" {
  description = "VPC ID"
  value       = kakaocloud_vpc.vpc.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = kakaocloud_vpc.vpc.cidr_block
}

output "subnet_id" {
  description = "Cluster subnet ID"
  value       = kakaocloud_subnet.main_subnet.id
}

output "subnet_cidr" {
  description = "Cluster subnet CIDR block"
  value       = kakaocloud_subnet.main_subnet.cidr_block
}

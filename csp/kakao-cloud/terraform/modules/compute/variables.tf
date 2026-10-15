variable "name_prefix" {
  description = "Instance name prefix"
  type        = string
}

variable "worker_count" {
  description = "Number of worker nodes"
  type        = number
}

variable "image_name" {
  description = "OS image name"
  type        = string
}

variable "master_flavor" {
  description = "Master instance flavor name"
  type        = string
}

variable "worker_flavor" {
  description = "Worker instance flavor name"
  type        = string
}

variable "volume_size" {
  description = "Boot volume size in GB"
  type        = number
}

variable "key_name" {
  description = "Kakao keypair name"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID to attach instances"
  type        = string
}

variable "subnet_cidr" {
  description = "Subnet CIDR (fixed private IPs are derived with cidrhost)"
  type        = string
}

variable "master_ip_offset" {
  description = "Host offset of master-1 in the subnet (Vagrant scheme: .10)"
  type        = number
  default     = 10
}

variable "worker_ip_offset" {
  description = "Host offset of worker-1 in the subnet (Vagrant scheme: .21, worker-i = offset + i-1)"
  type        = number
  default     = 21
}

variable "security_group_name" {
  description = "Node security group name"
  type        = string
}

variable "cloud_init_vars" {
  description = "Values shared by every node's cloud-init (proxy, CIDRs, domain, gateway ClusterIP)"
  type = object({
    vpc_cidr          = string
    proxy_url         = string
    no_proxy          = string
    apisix_cluster_ip = string
    base_domain       = string
  })
}

variable "lb_name" {
  description = "Load balancer name"
  type        = string
}

variable "lb_flavor_id" {
  description = "NLB flavor id, resolved by the root module so this module's depends_on cannot defer it"
  type        = string
}

variable "availability_zone" {
  description = "Availability zone"
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID to attach the load balancer"
  type        = string
}

variable "worker_private_ips" {
  description = "Worker private IPs (target group members)"
  type        = list(string)
}

variable "http_node_port" {
  description = "APISIX gateway HTTP NodePort"
  type        = number
}

variable "https_node_port" {
  description = "APISIX gateway HTTPS NodePort"
  type        = number
}

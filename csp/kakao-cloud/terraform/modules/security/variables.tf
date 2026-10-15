variable "security_group_name" {
  description = "Node security group name"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block for internal (cluster-only) rules"
  type        = string
}

variable "subnet_cidr" {
  description = "Cluster subnet CIDR — kubelet API only needs to be reachable from cluster nodes"
  type        = string
}

variable "bastion_private_ip" {
  description = "Bastion private IP — the only source allowed to SSH into nodes"
  type        = string
}

variable "gateway_node_ports" {
  description = "APISIX gateway NodePorts [http, https] opened to nodeport_source_cidrs for the NLB"
  type        = list(number)
}

variable "nodeport_source_cidrs" {
  description = "Sources allowed to reach the gateway NodePorts. Default is the VPC CIDR (NLB health checks and members). If the NLB preserves client source IPs (see README first-apply risks), widen ONLY this list — never the cluster ports."
  type        = list(string)
}

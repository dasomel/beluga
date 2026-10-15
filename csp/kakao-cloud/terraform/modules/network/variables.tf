variable "vpc_name" {
  description = "VPC name"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
}

variable "vpc_default_subnet_name" {
  description = "VPC default subnet name (Kakao Cloud names the auto-created subnet \"main\")"
  type        = string
  default     = "main"
}

variable "vpc_default_subnet_cidr" {
  description = "VPC default subnet CIDR block"
  type        = string
}

variable "subnet_name" {
  description = "Cluster subnet name"
  type        = string
}

variable "subnet_cidr" {
  description = "Cluster subnet CIDR block"
  type        = string
}

variable "availability_zone" {
  description = "Availability zone"
  type        = string
}

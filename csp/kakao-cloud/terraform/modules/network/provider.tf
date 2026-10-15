terraform {
  required_version = ">= 1.13.0"
  required_providers {
    kakaocloud = {
      source  = "registry.terraform.io/kakaoenterprise/kakaocloud"
      version = "0.5.1"
    }
  }
}

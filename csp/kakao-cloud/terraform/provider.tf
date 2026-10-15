terraform {
  required_version = ">= 1.13.0"
  required_providers {
    # Kakao Cloud provider — 정확한 버전 고정(0.x 는 마이너마다 스키마가 바뀐다).
    kakaocloud = {
      source  = "registry.terraform.io/kakaoenterprise/kakaocloud"
      version = "0.5.1"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# 자격증명은 변수로만 받는다(기본값 없음). 파일/상태에 평문으로 남기지 않으려면
# TF_VAR_application_credential_id / TF_VAR_application_credential_secret 환경변수를 쓴다.
provider "kakaocloud" {
  application_credential_id     = var.application_credential_id
  application_credential_secret = var.application_credential_secret
}

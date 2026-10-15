# Network module — VPC + 클러스터 서브넷.
#
# 문서화된 제공자 동작(0.5.x):
# - VPC 생성 시 기본 서브넷이 자동으로 만들어진다. kakaocloud_subnet.vpc_default_subnet 으로
#   관리해 `tofu destroy` 가 VPC 앞에서 이 서브넷에 막히지 않게 한다.
# - NAT 게이트웨이 리소스가 없다 → 노드는 사설 전용이고 외부 egress 는 bastion 의 squid
#   프록시를 거친다(D1, ../../bastion.tf).
# - VPC 삭제 직후 재생성하면 이름이 PENDING_DELETE 로 잠시 남아 충돌할 수 있다 — destroy 뒤
#   수 분 기다린 후 다시 apply 한다.
resource "kakaocloud_vpc" "vpc" {
  name       = var.vpc_name
  cidr_block = var.vpc_cidr
}

resource "kakaocloud_subnet" "vpc_default_subnet" {
  name              = var.vpc_default_subnet_name
  cidr_block        = var.vpc_default_subnet_cidr
  availability_zone = var.availability_zone
  vpc_id            = kakaocloud_vpc.vpc.id
}

resource "kakaocloud_subnet" "main_subnet" {
  name              = var.subnet_name
  cidr_block        = var.subnet_cidr
  availability_zone = var.availability_zone
  vpc_id            = kakaocloud_vpc.vpc.id
}

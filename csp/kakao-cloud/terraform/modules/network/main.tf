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
  route_table_id    = kakaocloud_route_table.public.id
}

# D-KAKAO-13: provider 0.5.1 은 VPC 를 만들 때 인터넷 게이트웨이(IGW)를 붙이지 않는다. IGW 가 없으면
# public IP 연결이 "VPC ... has no IGW attached" (409) 로 실패한다(2026-10-16 첫 라이브 apply 실측).
# - 비용: IGW 1개(VPC 당). 노드는 여전히 public IP 가 없으므로 노출 범위는 바뀌지 않는다.
# - 탈출구: 콘솔에서 만든 IGW 를 쓰려면 이 두 리소스를 지우고 attachment 를 import 한다
#   (`tofu import module.network.kakaocloud_internet_gateway_attachment.igw <igw_id>/<vpc_id>`).
resource "kakaocloud_internet_gateway" "igw" {
  name = "${var.vpc_name}-igw"
}

resource "kakaocloud_internet_gateway_attachment" "igw" {
  internet_gateway_id = kakaocloud_internet_gateway.igw.id
  vpc_id              = kakaocloud_vpc.vpc.id
}

# D-KAKAO-14: IGW 를 붙여도 VPC 기본 라우트 테이블에는 로컬 경로(VPC CIDR)만 있어, public IP 로 들어온
# 패킷의 응답이 나가지 못한다(bastion SSH 타임아웃, 2026-10-16 라이브 실측). 0.0.0.0/0 → IGW 경로를 가진
# 라우트 테이블을 만들고 두 서브넷을 route_table_id 로 명시 연결한다(in-place 연결 변경, 서브넷 재생성 없음).
# - is_main 으로 바꾸는 방식은 쓰지 않는다: main 지정만으로는 기존 서브넷 연결이 옮겨지지 않았다(라이브 실측).
# - 기본 테이블은 VPC 가 만든 것이라 import 할 ID 를 plan 시점에 알 수 없어(신규 스택) 관리 대상으로 가져올 수 없다.
# - 비용: 노드도 이 라우트 테이블을 쓰지만 public IP 가 없으므로 인터넷에서 노드로 들어오는 경로는 생기지 않는다.
# - 탈출구: 콘솔 기본 테이블에 경로를 직접 추가하고 이 리소스를 지운다.
resource "kakaocloud_route_table" "public" {
  name   = "${var.vpc_name}-public-rt"
  vpc_id = kakaocloud_vpc.vpc.id

  request_routes = [{
    destination = "0.0.0.0/0"
    target_id   = kakaocloud_internet_gateway.igw.id
    target_type = "igw"
  }]

  depends_on = [kakaocloud_internet_gateway_attachment.igw]
}

resource "kakaocloud_subnet" "main_subnet" {
  name              = var.subnet_name
  cidr_block        = var.subnet_cidr
  availability_zone = var.availability_zone
  vpc_id            = kakaocloud_vpc.vpc.id
  route_table_id    = kakaocloud_route_table.public.id
}

# Load balancer module — 단일 NLB: TCP 80/443 → 워커 NodePort(31080/31443) → APISIX (D2).
# K8s API(6443)는 공개하지 않는다 — kubectl 은 bastion SSH 터널로만 접근한다.
#
# NLB 는 L4 패스스루라 TLS 는 APISIX 가 그대로 종료한다(cert-manager 내부 CA, 변경 없음).
# flavor 조회는 루트 모듈에서 한다: 이 모듈에 module-level depends_on 이 걸려 있으면 data source 가
# apply 시점으로 밀려 flavor_id 가 unknown 이 되고 LB 가 불필요하게 교체된다(../../main.tf 주석).

resource "kakaocloud_load_balancer" "gateway" {
  name              = var.lb_name
  description       = "Beluga gateway NLB (80/443 to APISIX NodePorts)"
  availability_zone = var.availability_zone
  subnet_id         = var.subnet_id
  flavor_id         = var.lb_flavor_id
}

resource "kakaocloud_load_balancer_listener" "http" {
  load_balancer_id = kakaocloud_load_balancer.gateway.id
  protocol         = "TCP"
  protocol_port    = 80
}

resource "kakaocloud_load_balancer_listener" "https" {
  load_balancer_id = kakaocloud_load_balancer.gateway.id
  protocol         = "TCP"
  protocol_port    = 443
}

resource "kakaocloud_load_balancer_target_group" "http" {
  name                    = "gateway-http-tg"
  description             = "APISIX gateway HTTP NodePort on workers"
  load_balancer_id        = kakaocloud_load_balancer.gateway.id
  listener_id             = kakaocloud_load_balancer_listener.http.id
  protocol                = "TCP"
  load_balancer_algorithm = "ROUND_ROBIN"
}

resource "kakaocloud_load_balancer_target_group" "https" {
  name                    = "gateway-https-tg"
  description             = "APISIX gateway HTTPS NodePort on workers"
  load_balancer_id        = kakaocloud_load_balancer.gateway.id
  listener_id             = kakaocloud_load_balancer_listener.https.id
  protocol                = "TCP"
  load_balancer_algorithm = "ROUND_ROBIN"
}

resource "kakaocloud_load_balancer_target_group_member" "http" {
  for_each        = { for i, ip in var.worker_private_ips : i => ip }
  target_group_id = kakaocloud_load_balancer_target_group.http.id
  address         = each.value
  subnet_id       = var.subnet_id
  protocol_port   = var.http_node_port
  weight          = 1
}

resource "kakaocloud_load_balancer_target_group_member" "https" {
  for_each        = { for i, ip in var.worker_private_ips : i => ip }
  target_group_id = kakaocloud_load_balancer_target_group.https.id
  address         = each.value
  subnet_id       = var.subnet_id
  protocol_port   = var.https_node_port
  weight          = 1
}

# TCP 헬스 모니터: 이것이 없으면 NLB 가 리슨하지 않는 멤버에도 라운드로빈한다. APISIX 파드가
# 1 replica 라 대부분의 워커는 NodePort 만 열려 있고(Cilium 이 모든 노드에서 연다) 파드가 없다 —
# 파드 없는 노드로 가도 Cilium 이 파드가 있는 노드로 포워딩하므로 TCP 핸드셰이크 성공이 올바른 기준이다.
resource "kakaocloud_load_balancer_health_monitor" "http" {
  target_group_id  = kakaocloud_load_balancer_target_group.http.id
  type             = "TCP"
  delay            = 5
  timeout          = 3
  max_retries      = 2
  max_retries_down = 3
}

resource "kakaocloud_load_balancer_health_monitor" "https" {
  target_group_id  = kakaocloud_load_balancer_target_group.https.id
  type             = "TCP"
  delay            = 5
  timeout          = 3
  max_retries      = 2
  max_retries_down = 3
}

# D-KAKAO-12: 공인 IP 할당은 NLB 수명과 독립된 리소스다. ignore_changes 이유: NLB 가 교체되면 provider 가
# 삭제된 옛 LB 에 detach 를 호출해 apply 가 실패한다. 비용: NLB 교체 후 IP 주소는 보존되지만 새 NLB 에는
# 자동 재연결되지 않는다 — 수동 재연결 절차는 README "공인 IP 고정". 탈출구: 재연결 후 `tofu apply -refresh-only`.
resource "kakaocloud_public_ip" "gateway" {
  description = "Public IP for Beluga gateway NLB (80/443)"

  related_resource = {
    device_id   = kakaocloud_load_balancer.gateway.id
    device_type = "load-balancer"
  }

  lifecycle {
    ignore_changes = [related_resource]
  }
}

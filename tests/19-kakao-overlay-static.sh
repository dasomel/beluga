#!/usr/bin/env bash
# Kakao Cloud 오버레이 정적 계약 (csp/kakao-cloud) — 클러스터·클라우드 자격증명 불필요.
# "렌더/파일 일관성"만 증명한다. 실제 apply·NLB·NodePort 도달성은 증명하지 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KAKAO="${ROOT}/csp/kakao-cloud"
FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }

# 게이트웨이 Service 문서만 추출 (렌더는 한 줄 helm 호출로 분리: 핀 검사기가 파싱 가능해야 한다)
cd "${ROOT}"
render_default() {
  helm template gitops/charts/beluga-platform --show-only templates/apisix-gateway.yaml
}
render_kakao() {
  helm template gitops/charts/beluga-platform -f gitops/charts/beluga-platform/values-kakao.yaml --show-only templates/apisix-gateway.yaml
}
extract_service() {
  awk '/^kind: Service$/{f=1} f&&/name: apisix-gateway$/{p=1} p{print} p&&/^---$/{exit}'
}

# 1) 기본 경로 불변: 기본 렌더의 게이트웨이 Service 는 MetalLB LoadBalancer 그대로
default_svc="$(render_default | extract_service)"
grep -q 'type: LoadBalancer' <<<"${default_svc}" || fail "default render: apisix-gateway is not type LoadBalancer"
grep -q 'metallb.universe.tf/loadBalancerIPs' <<<"${default_svc}" || fail "default render: metallb annotation missing"
grep -q 'nodePort:' <<<"${default_svc}" && fail "default render: unexpected nodePort"
grep -q 'clusterIP:' <<<"${default_svc}" && fail "default render: unexpected clusterIP"

# 2) 오버레이 렌더: NodePort 31080/31443 + 고정 ClusterIP, MetalLB 어노테이션 없음
kakao_svc="$(render_kakao | extract_service)"
grep -q 'type: NodePort' <<<"${kakao_svc}" || fail "kakao render: type is not NodePort"
grep -q 'nodePort: 31080' <<<"${kakao_svc}" || fail "kakao render: nodePort 31080 missing"
grep -q 'nodePort: 31443' <<<"${kakao_svc}" || fail "kakao render: nodePort 31443 missing"
grep -q 'clusterIP: "10.43.0.200"' <<<"${kakao_svc}" || fail "kakao render: clusterIP 10.43.0.200 missing"
grep -q 'metallb' <<<"${kakao_svc}" && fail "kakao render: metallb annotation must not be rendered"

# 3) terraform 기본값과 차트 오버레이가 같은 값을 쓴다(NodePort, ClusterIP)
tf_default() { # 변수명 → default 값
  awk -v name="$1" '$0 ~ "variable \""name"\"" {f=1} f&&/default/{gsub(/[" ]/,"",$3); print $3; exit}' "${KAKAO}/terraform/variables.tf"
}
[[ "$(tf_default gateway_http_node_port)" == "31080" ]] || fail "terraform gateway_http_node_port default != 31080"
[[ "$(tf_default gateway_https_node_port)" == "31443" ]] || fail "terraform gateway_https_node_port default != 31443"
[[ "$(tf_default apisix_cluster_ip)" == "10.43.0.200" ]] || fail "terraform apisix_cluster_ip default != 10.43.0.200"

# 4) ArgoCD 오버레이: beluga-platform/beluga-data 변형은 기본 Application 과 helm.valueFiles 만 다르다,
#    루트는 자기 자신/기본 루트를 포함하지 않는다
python3 -I - "${ROOT}" <<'PY' || FAILED=1
import sys, pathlib, copy
import yaml

root = pathlib.Path(sys.argv[1])
base = yaml.safe_load((root / "gitops/apps/beluga-platform.yaml").read_text())
kakao = yaml.safe_load((root / "csp/kakao-cloud/gitops/apps/beluga-platform.yaml").read_text())
vf = kakao["spec"]["source"]["helm"].pop("valueFiles")
if vf != ["values.yaml", "values-kakao.yaml", "../../values/sso.yaml", "../../values/domain-kakao.yaml"]:
    sys.exit(f"FAIL: unexpected valueFiles {vf}")
base_vf = base["spec"]["source"]["helm"].pop("valueFiles")
if base_vf != ["../../values/sso.yaml"]:
    sys.exit(f"FAIL: unexpected base valueFiles {base_vf}")
if not kakao["spec"]["source"]["helm"]:
    del kakao["spec"]["source"]["helm"]
if not base["spec"]["source"]["helm"]:
    del base["spec"]["source"]["helm"]
if kakao != base:
    sys.exit("FAIL: kakao beluga-platform Application drifted from gitops/apps/beluga-platform.yaml (only helm.valueFiles may differ)")

# D-DOM-4: beluga-data 변형도 valueFiles 만 다르다 (domain-kakao.yaml 로 baseDomain 전달)
dbase = yaml.safe_load((root / "gitops/apps/beluga-data.yaml").read_text())
dkakao = yaml.safe_load((root / "csp/kakao-cloud/gitops/apps/beluga-data.yaml").read_text())
dvf = dkakao["spec"]["source"]["helm"].pop("valueFiles")
if dvf != ["../../values/sso.yaml", "../../values/domain-kakao.yaml"]:
    sys.exit(f"FAIL: unexpected beluga-data valueFiles {dvf}")
dbvf = dbase["spec"]["source"]["helm"].pop("valueFiles")
if dbvf != ["../../values/sso.yaml"]:
    sys.exit(f"FAIL: unexpected base beluga-data valueFiles {dbvf}")
for d in (dbase, dkakao):
    if not d["spec"]["source"]["helm"]:
        del d["spec"]["source"]["helm"]
if dkakao != dbase:
    sys.exit("FAIL: kakao beluga-data Application drifted from gitops/apps/beluga-data.yaml (only helm.valueFiles may differ)")

app = yaml.safe_load((root / "csp/kakao-cloud/gitops/app-of-apps-kakao.yaml").read_text())
srcs = app["spec"]["sources"]
paths = [s["path"] for s in srcs]
if paths != ["gitops/apps", "csp/kakao-cloud/gitops/apps"]:
    sys.exit(f"FAIL: unexpected root sources {paths}")
excl = srcs[0]["directory"]["exclude"].strip("{}").split(",")
if sorted(excl) != ["app-of-apps.yaml", "beluga-data.yaml", "beluga-platform.yaml"]:
    sys.exit(f"FAIL: unexpected exclude {excl}")
# 제외 후 gitops/apps 에 남는 Application 이 kakao 변형과 이름이 겹치면 안 된다
remaining = [p.name for p in (root / "gitops/apps").glob("*.yaml") if p.name not in excl]
for name in remaining:
    doc = yaml.safe_load((root / "gitops/apps" / name).read_text())
    if doc["metadata"]["name"] in ("beluga-platform", "beluga-data"):
        sys.exit(f"FAIL: {name} also defines {doc['metadata']['name']}")
# 자기 참조 재귀 방지: 루트 파일은 어떤 소스 디렉터리 안에도 없다
for p in paths:
    if (root / p / "app-of-apps-kakao.yaml").exists():
        sys.exit(f"FAIL: root app file lives inside its own source dir {p}")
print("kakao ArgoCD overlay OK")
PY

# 4a) 도메인 분리(D-DOM-1/2/5): Kakao 는 kakao.beluga.internal, 기본(Vagrant)은 local.beluga.internal
CHART_DOMAIN="$(awk -F'"' '/^baseDomain:/{print $2}' "${ROOT}/gitops/values/domain-kakao.yaml")"
[[ "${CHART_DOMAIN}" == "kakao.beluga.internal" ]] || fail "domain-kakao.yaml baseDomain is '${CHART_DOMAIN}', expected kakao.beluga.internal"
[[ "$(tf_default base_domain)" == "${CHART_DOMAIN}" ]] || fail "terraform base_domain default != domain-kakao.yaml baseDomain"
grep -q '"local.beluga.internal"' "${KAKAO}/terraform/variables.tf" && fail "terraform variables.tf still pins local.beluga.internal"
grep -q 'baseDomain: "local.beluga.internal"' gitops/charts/beluga-platform/values.yaml || fail "platform default baseDomain is not local.beluga.internal"
grep -q 'baseDomain: "local.beluga.internal"' gitops/charts/beluga-data/values.yaml || fail "data default baseDomain is not local.beluga.internal"
# 렌더는 한 줄 helm 호출 함수로 분리(핀 검사기가 파싱 가능해야 한다)
render_kakao_platform() {
  helm template gitops/charts/beluga-platform -f gitops/charts/beluga-platform/values.yaml -f gitops/charts/beluga-platform/values-kakao.yaml -f gitops/values/sso.yaml -f gitops/values/domain-kakao.yaml
}
render_kakao_data() {
  helm template gitops/charts/beluga-data -f gitops/values/sso.yaml -f gitops/values/domain-kakao.yaml
}
render_kakao_data_full() {
  helm template gitops/charts/beluga-data -f gitops/values/sso.yaml -f gitops/values/domain-kakao.yaml --set trino.workerEnabled=true,openmetadata.enabled=true
}
render_default_platform() {
  helm template gitops/charts/beluga-platform -f gitops/values/sso.yaml
}
render_default_data() {
  helm template gitops/charts/beluga-data -f gitops/values/sso.yaml
}
render_stale_sso_data() {
  helm template gitops/charts/beluga-data -f "$1"
}
k_plat="$(render_kakao_platform)"
k_data="$(render_kakao_data)"
k_full="$(render_kakao_data_full)"
d_plat="$(render_default_platform)"
d_data="$(render_default_data)"
for pair in "kakao platform:${k_plat}" "kakao data:${k_data}" "kakao data(openmetadata):${k_full}"; do
  grep -q 'local\.beluga\.internal' <<<"${pair#*:}" && fail "${pair%%:*} render still contains local.beluga.internal"
  grep -q 'sso\.kakao\.beluga\.internal' <<<"${pair#*:}" || fail "${pair%%:*} render has no sso.kakao.beluga.internal"
done
for pair in "default platform:${d_plat}" "default data:${d_data}"; do
  grep -q 'kakao\.beluga\.internal' <<<"${pair#*:}" && fail "${pair%%:*} render leaks kakao.beluga.internal"
  grep -q 'sso\.local\.beluga\.internal' <<<"${pair#*:}" || fail "${pair%%:*} render has no sso.local.beluga.internal"
done
# sso.yaml 에 FQDN 이 박히면(드리프트) 차트가 렌더를 거부한다
stale_sso="$(mktemp)"
sed 's/host: "flink"/host: "flink.local.beluga.internal"/' gitops/values/sso.yaml > "${stale_sso}"
if render_stale_sso_data "${stale_sso}" >/dev/null 2>&1; then
  fail "chart accepted an FQDN host in sso.yaml (beluga.ssoHost guard missing)"
fi
rm -f "${stale_sso}"

# 4c) hosts.sh: Vagrant 와 Kakao 블록은 BASE_DOMAIN별 마커라 공존하고 서로 건드리지 않는다(실 /etc/hosts 불변: 임시 파일)
hosts_tmp="$(mktemp)"
printf '127.0.0.1 localhost\n' > "${hosts_tmp}"
KUBECONFIG=/dev/null HOSTS_FILE="${hosts_tmp}" bash "${ROOT}/scripts/hosts.sh" --apply >/dev/null 2>&1 || fail "hosts.sh --apply (default domain) failed"
KUBECONFIG=/dev/null HOSTS_FILE="${hosts_tmp}" APISIX_LB_IP=203.0.113.9 BASE_DOMAIN=kakao.beluga.internal bash "${ROOT}/scripts/hosts.sh" --apply >/dev/null 2>&1 || fail "hosts.sh --apply (kakao) failed"
[[ "$(grep -c '^192\.168\.77\.200 .*\.local\.beluga\.internal$' "${hosts_tmp}")" -ge 1 ]] || fail "hosts.sh: Vagrant block missing after the Kakao apply"
[[ "$(grep -c '^203\.0\.113\.9 .*\.kakao\.beluga\.internal$' "${hosts_tmp}")" -ge 1 ]] || fail "hosts.sh: Kakao block missing"
KUBECONFIG=/dev/null HOSTS_FILE="${hosts_tmp}" BASE_DOMAIN=kakao.beluga.internal bash "${ROOT}/scripts/hosts.sh" --remove >/dev/null 2>&1 || fail "hosts.sh --remove (kakao) failed"
grep -q 'kakao\.beluga\.internal' "${hosts_tmp}" && fail "hosts.sh: Kakao block survived --remove"
grep -q '^192\.168\.77\.200 .*\.local\.beluga\.internal$' "${hosts_tmp}" || fail "hosts.sh: removing the Kakao block also removed the Vagrant block"
rm -f "${hosts_tmp}" "${hosts_tmp}".bak.*

# 4b) nodeport_source_cidrs 는 0.0.0.0/0, ::/0 를 거부하는 validation 을 가진다
grep -q 'contains(\["0.0.0.0/0", "::/0"\], cidr)' "${KAKAO}/terraform/variables.tf" || fail "nodeport_source_cidrs validation rejecting 0.0.0.0/0 and ::/0 is missing"

# 5) 노드 보안그룹에 0.0.0.0/0 ingress 가 없다(egress 한 줄만 허용)
if awk '/direction *= *"ingress"/{ing=1} ing&&/remote_ip_prefix *= *"0.0.0.0\/0"/{print FILENAME": "FNR; ing=0} /direction *= *"egress"/{ing=0}' \
  "${KAKAO}/terraform/modules/security/main.tf" | grep -q .; then
  fail "node security group has a 0.0.0.0/0 ingress rule"
fi

# 6) 공인 IP 고정(D-KAKAO-12): bastion 인스턴스는 독립 NI 를 쓰고, 두 public_ip 는 related_resource 변경을 무시한다
python3 -I - "${KAKAO}/terraform" <<'PY' || FAILED=1
import sys, pathlib, re

tf = pathlib.Path(sys.argv[1])

def block(text, header):
    """`resource "type" "name" {` 부터 짝이 맞는 닫는 중괄호까지 (주석 줄 제외)."""
    lines = [l for l in text.splitlines() if not l.lstrip().startswith("#")]
    out, depth, on = [], 0, False
    for l in lines:
        if not on and l.strip().startswith(header):
            on = True
        if on:
            out.append(l)
            depth += l.count("{") - l.count("}")
            if depth == 0:
                break
    if not out:
        sys.exit(f"FAIL: {header} not found")
    return "\n".join(out)

bastion = (tf / "bastion.tf").read_text()
inst = block(bastion, 'resource "kakaocloud_instance" "bastion"')
if not re.search(r"^\s*network_interface_id\s*=\s*kakaocloud_network_interface\.bastion\.id\s*$", inst, re.M):
    sys.exit("FAIL: bastion instance does not use network_interface_id of the standalone NI")
if re.search(r"^\s*private_ip\s*=", inst, re.M):
    sys.exit("FAIL: bastion instance still sets an inline private_ip")

if re.search(r"^\s*initial_security_groups\s*=", inst, re.M):
    sys.exit("FAIL: bastion instance sets initial_security_groups (rejected together with network_interface_id)")
ni = block(bastion, 'resource "kakaocloud_network_interface" "bastion"')
if not re.search(r"^\s*id\s*=\s*kakaocloud_security_group\.bastion\.id\s*$", ni, re.M):
    sys.exit("FAIL: bastion NI security_groups does not reference the bastion SG")
pip = block(bastion, 'resource "kakaocloud_public_ip" "bastion"')
if not re.search(r"^\s*id\s*=\s*kakaocloud_network_interface\.bastion\.id\s*$", pip, re.M):
    sys.exit("FAIL: public_ip.bastion related_resource.id does not reference the bastion NI")

pat = r"^\s*ignore_changes\s*=\s*\[\s*related_resource\s*\]\s*$"
for label, text, header in (
    ("bastion", bastion, 'resource "kakaocloud_public_ip" "bastion"'),
    ("gateway", (tf / "modules/loadbalancer/main.tf").read_text(), 'resource "kakaocloud_public_ip" "gateway"'),
):
    if not re.search(pat, block(text, header), re.M):
        sys.exit(f"FAIL: {label} public_ip lacks lifecycle ignore_changes = [related_resource]")
print("kakao stable public IP contract OK")
PY

# 7) 라이브 apply 에서 나온 계약(D-KAKAO-13/14/15 + bastion 오프셋)
python3 -I - "${KAKAO}/terraform" <<'PY' || FAILED=1
import sys, pathlib, re

tf = pathlib.Path(sys.argv[1])

def block(text, header):
    lines = [l for l in text.splitlines() if not l.lstrip().startswith("#")]
    out, depth, on = [], 0, False
    for l in lines:
        if not on and l.strip().startswith(header):
            on = True
        if on:
            out.append(l)
            depth += l.count("{") - l.count("}")
            if depth == 0:
                break
    if not out:
        sys.exit(f"FAIL: {header} not found")
    return "\n".join(out)

net = (tf / "modules/network/main.tf").read_text()

# D-KAKAO-13: IGW 와 VPC 연결(provider 는 자동으로 붙이지 않는다)
block(net, 'resource "kakaocloud_internet_gateway" "igw"')
att = block(net, 'resource "kakaocloud_internet_gateway_attachment" "igw"')
if not re.search(r"internet_gateway_id\s*=\s*kakaocloud_internet_gateway\.igw\.id", att):
    sys.exit("FAIL: IGW attachment does not reference the IGW")
if not re.search(r"vpc_id\s*=\s*kakaocloud_vpc\.vpc\.id", att):
    sys.exit("FAIL: IGW attachment does not reference the VPC")

# D-KAKAO-14: 0.0.0.0/0 -> igw 라우트, 두 서브넷이 route_table_id 로 참조, is_main 미사용
rt = block(net, 'resource "kakaocloud_route_table" "public"')
if not (re.search(r'destination\s*=\s*"0\.0\.0\.0/0"', rt)
        and re.search(r"target_id\s*=\s*kakaocloud_internet_gateway\.igw\.id", rt)
        and re.search(r'target_type\s*=\s*"igw"', rt)):
    sys.exit("FAIL: route table lacks 0.0.0.0/0 -> igw route")
if re.search(r"^\s*is_main\s*=", rt, re.M):
    sys.exit("FAIL: route table sets is_main (main table cannot be deleted; associations do not move)")
for sn in ("vpc_default_subnet", "main_subnet"):
    b = block(net, f'resource "kakaocloud_subnet" "{sn}"')
    if not re.search(r"route_table_id\s*=\s*kakaocloud_route_table\.public\.id", b):
        sys.exit(f"FAIL: subnet {sn} does not reference the public route table")

# D-KAKAO-15: squid 는 IPv6 를 거르는 로컬 dnsmasq 로 해석하고, dnsmasq 가 squid 보다 먼저 뜬다
ci = (tf / "templates/cloud-init-bastion.yaml.tftpl").read_text()
code = "\n".join(l for l in ci.splitlines() if not l.lstrip().startswith("#"))
if not re.search(r"^\s*filter-AAAA\s*$", code, re.M):
    sys.exit("FAIL: bastion dnsmasq lacks filter-AAAA")
if not re.search(r"^\s*dns_nameservers\s+127\.0\.0\.1\s*$", code, re.M):
    sys.exit("FAIL: squid dns_nameservers is not 127.0.0.1")
dn = re.search(r"systemctl\s+(?:enable\s+--now|restart|start)\s+dnsmasq", code)
sq = re.search(r"systemctl\s+(?:enable\s+--now|restart|start)\s+squid", code)
if not dn or not sq or dn.start() > sq.start():
    sys.exit("FAIL: dnsmasq must be started before squid in bastion runcmd")

# D-KAKAO-16: VPC DNS 타임아웃 대비 — bootcmd(packages 보다 먼저)가 resolved 드롭인을 깔고 재시작한다
if not re.search(r"^bootcmd:\s*$", code, re.M) or code.find("bootcmd:") > code.find("packages:"):
    sys.exit("FAIL: bastion cloud-init lacks bootcmd ahead of packages")
if "/etc/systemd/resolved.conf.d/beluga-upstream.conf" not in code or "systemctl restart systemd-resolved" not in code:
    sys.exit("FAIL: bastion bootcmd must write the resolved upstream drop-in and restart systemd-resolved")
ub = block((tf / "variables.tf").read_text(), 'variable "bastion_upstream_dns"')
if not re.search(r'default\s*=\s*\["1\.1\.1\.1",\s*"8\.8\.8\.8"\]', ub) or "can(regex(" not in ub:
    sys.exit("FAIL: bastion_upstream_dns default/IPv4 validation missing")
if "upstream_dns = var.bastion_upstream_dns" not in (tf / "bastion.tf").read_text():
    sys.exit("FAIL: bastion_upstream_dns not passed to the bastion template")

# bastion_ip_offset: Kakao 예약 저대역(.5 라이브 거부) 회피
var = (tf / "variables.tf").read_text()
b = block(var, 'variable "bastion_ip_offset"')
m = re.search(r"^\s*default\s*=\s*(\d+)\s*$", b, re.M)
if not m or int(m.group(1)) < 11:
    sys.exit("FAIL: bastion_ip_offset default must be >= 11")
if "var.bastion_ip_offset >= 11" not in b:
    sys.exit("FAIL: bastion_ip_offset validation (>= 11) missing")
print("kakao live-apply contract OK")
PY

if [[ ${FAILED} -ne 0 ]]; then
  exit 1
fi
echo "PASS: Kakao Cloud overlay static contract"

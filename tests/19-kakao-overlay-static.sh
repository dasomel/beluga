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

# 4) ArgoCD 오버레이: beluga-platform 변형은 기본 Application 과 helm.valueFiles 만 다르다,
#    루트는 자기 자신/기본 루트를 포함하지 않는다
python3 -I - "${ROOT}" <<'PY' || FAILED=1
import sys, pathlib, copy
import yaml

root = pathlib.Path(sys.argv[1])
base = yaml.safe_load((root / "gitops/apps/beluga-platform.yaml").read_text())
kakao = yaml.safe_load((root / "csp/kakao-cloud/gitops/apps/beluga-platform.yaml").read_text())
vf = kakao["spec"]["source"]["helm"].pop("valueFiles")
if vf != ["values.yaml", "values-kakao.yaml"]:
    sys.exit(f"FAIL: unexpected valueFiles {vf}")
if not kakao["spec"]["source"]["helm"]:
    del kakao["spec"]["source"]["helm"]
if kakao != base:
    sys.exit("FAIL: kakao beluga-platform Application drifted from gitops/apps/beluga-platform.yaml (only helm.valueFiles may differ)")

app = yaml.safe_load((root / "csp/kakao-cloud/gitops/app-of-apps-kakao.yaml").read_text())
srcs = app["spec"]["sources"]
paths = [s["path"] for s in srcs]
if paths != ["gitops/apps", "csp/kakao-cloud/gitops/apps"]:
    sys.exit(f"FAIL: unexpected root sources {paths}")
excl = srcs[0]["directory"]["exclude"].strip("{}").split(",")
if sorted(excl) != ["app-of-apps.yaml", "beluga-platform.yaml"]:
    sys.exit(f"FAIL: unexpected exclude {excl}")
# 제외 후 gitops/apps 에 남는 Application 이 kakao 변형과 이름이 겹치면 안 된다
remaining = [p.name for p in (root / "gitops/apps").glob("*.yaml") if p.name not in excl]
for name in remaining:
    doc = yaml.safe_load((root / "gitops/apps" / name).read_text())
    if doc["metadata"]["name"] == "beluga-platform":
        sys.exit(f"FAIL: {name} also defines beluga-platform")
# 자기 참조 재귀 방지: 루트 파일은 어떤 소스 디렉터리 안에도 없다
for p in paths:
    if (root / p / "app-of-apps-kakao.yaml").exists():
        sys.exit(f"FAIL: root app file lives inside its own source dir {p}")
print("kakao ArgoCD overlay OK")
PY

# 5) 노드 보안그룹에 0.0.0.0/0 ingress 가 없다(egress 한 줄만 허용)
if awk '/direction *= *"ingress"/{ing=1} ing&&/remote_ip_prefix *= *"0.0.0.0\/0"/{print FILENAME": "FNR; ing=0} /direction *= *"egress"/{ing=0}' \
  "${KAKAO}/terraform/modules/security/main.tf" | grep -q .; then
  fail "node security group has a 0.0.0.0/0 ingress rule"
fi

if [[ ${FAILED} -ne 0 ]]; then
  exit 1
fi
echo "PASS: Kakao Cloud overlay static contract"

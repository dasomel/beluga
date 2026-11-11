#!/usr/bin/env bash
# LIVE ONLY: opt in after deploying reader code, identity, grants and network policy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../scripts/common/logging.sh"
if [[ "${MANAGER_LAKEKEEPER_LIVE:-}" != "1" ]]; then
  log_warn "SKIP: set MANAGER_LAKEKEEPER_LIVE=1 after rollout (ADR-0010)"
  exit 0
fi
export BASE_DOMAIN="${BASE_DOMAIN:-local.beluga.internal}"
GATEWAY_IP="${BELUGA_GATEWAY_IP:-127.0.0.1}"
HOST="manager.${BASE_DOMAIN}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
trap 'exit 130' INT TERM
umask 077
# D-MCAT-7: isolate shared contexts before live queries; opt-in above precedes cluster access.
# Cost: temporary config; escape hatch: regenerate repo-local kubeconfig.
kubectl --kubeconfig "${KUBECONFIG:-${SCRIPT_DIR}/../.kube/config}" config view --minify --flatten > "${TMP_DIR}/kubeconfig"
export KUBECONFIG="${TMP_DIR}/kubeconfig"
CA_CERT="${TMP_DIR}/ca.crt"
kubectl -n platform-system get configmap beluga-internal-ca -o jsonpath='{.data.ca\.crt}' > "${CA_CERT}"
test -s "${CA_CERT}"
fail() { log_error "$*"; exit 1; }
run_curl() {
  curl -s -S --max-time 30 --cacert "${CA_CERT}" \
    --resolve "sso.${BASE_DOMAIN}:443:${GATEWAY_IP}" --resolve "${HOST}:443:${GATEWAY_IP}" \
    --resolve "catalog.${BASE_DOMAIN}:443:${GATEWAY_IP}" "$@"
}
extract_login_action() {
  local html="$1" action
  action="$(printf '%s' "${html}" | grep -o 'action="[^"]*"' | head -n1 | cut -d'"' -f2 | sed 's/&amp;/\&/g')"
  case "${action}" in
    "https://sso.${BASE_DOMAIN}/realms/beluga/login-actions/"*) printf '%s' "${action}" ;;
    *) printf '' ;;
  esac
}

# login_bearer <keycloak-user> <secret-key> <header-file>: tests/22 verify_manager_pkce_login와 같은 PKCE(S256) 흐름.
# 결과는 "Authorization: Bearer ..." 한 줄을 담은 0600 파일이다. 비밀번호는 0600 파일에서 --data-urlencode password@file.
login_bearer() {
  local user="$1" key="$2" header_file="$3"
  local sso="https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect"
  local redirect_uri="https://${HOST}/auth/callback"
  local redirect_enc="https%3A%2F%2F${HOST}%2Fauth%2Fcallback"
  local jar="${TMP_DIR}/jar_${key}.txt" pass_file="${TMP_DIR}/${key}.pass"
  rm -f "${jar}"
  (umask 077 && kubectl get secret -n iam keycloak-user-passwords -o "jsonpath={.data.${key}}" | base64 -d > "${pass_file}")
  if [[ ! -s "${pass_file}" ]]; then
    fail "Secret iam/keycloak-user-passwords 키 ${key} 없음"
  fi

  local verifier challenge state nonce
  verifier="$(openssl rand -base64 64 | tr -d '=+/\n' | cut -c1-64)"
  challenge="$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
  state="$(openssl rand -hex 12)"
  nonce="$(openssl rand -hex 12)"

  local login_html action
  login_html="$(run_curl -c "${jar}" -b "${jar}" -L "${sso}/auth?client_id=beluga-manager&response_type=code&scope=openid%20profile%20email&redirect_uri=${redirect_enc}&state=${state}&nonce=${nonce}&code_challenge=${challenge}&code_challenge_method=S256" 2>&1 || true)"
  action="$(extract_login_action "${login_html}")"
  if [[ -z "${action}" ]]; then
    fail "[${user}] Keycloak 로그인 폼 action 추출 실패"
  fi
  local post_headers cb_loc code
  post_headers="$(run_curl -c "${jar}" -b "${jar}" -d "username=${user}" --data-urlencode "password@${pass_file}" -d "credentialId=" -i "${action}" 2>&1 || true)"
  cb_loc="$(printf '%s' "${post_headers}" | awk -F': ' 'tolower($1)=="location" {print $2}' | tr -d '\r' | tail -n1)"
  code="$(printf '%s' "${cb_loc}" | sed -n 's/.*[?&]code=\([^&#]*\).*/\1/p')"
  if [[ "${cb_loc}" != "${redirect_uri}?"* || -z "${code}" ]]; then
    fail "[${user}] 로그인 후 authorization code 획득 실패"
  fi

  local form_file="${TMP_DIR}/token_form_${key}.txt" token_json="${TMP_DIR}/token_${key}.json" token_code
  (umask 077 && printf 'grant_type=authorization_code&client_id=beluga-manager&code=%s&redirect_uri=%s&code_verifier=%s' \
    "${code}" "${redirect_enc}" "${verifier}" > "${form_file}")
  token_code="$(run_curl -o "${token_json}" -w "%{http_code}" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-binary "@${form_file}" "${sso}/token" 2>&1 || true)"
  rm -f "${form_file}" "${pass_file}"
  if [[ "${token_code}" != "200" ]]; then
    rm -f "${token_json}"
    fail "[${user}] PKCE 토큰 교환 실패 (HTTP ${token_code})"
  fi
  TOKEN_JSON="${token_json}" HEADER_FILE="${header_file}" python3 -c '
import json, os
tok = json.load(open(os.environ["TOKEN_JSON"]))["access_token"]
fd = os.open(os.environ["HEADER_FILE"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("Authorization: Bearer " + tok + "\n")
'
  rm -f "${token_json}"
  log_success "[${user}] PKCE 로그인 완료, bearer 획득 (값 미출력)"
}

# Use a non-admin PKCE session, exactly the documented Manager browser login contract.
login_bearer beluga-analyst analyst "${TMP_DIR}/manager.header"
run_curl -f -H "@${TMP_DIR}/manager.header" "https://${HOST}/api/v1/health" > "${TMP_DIR}/health.json"
# Exercise the explicit ingress exception from the actual Manager pod. No secrets in argv/stdout.
kubectl -n platform-system exec deployment/manager-domain-api -- node -e '
(async () => {
  const token = await fetch(process.env.BELUGA_LAKEKEEPER_TOKEN_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    body: new URLSearchParams({grant_type: "client_credentials", scope: "openid",
      client_id: process.env.BELUGA_LAKEKEEPER_CLIENT_ID, client_secret: process.env.BELUGA_LAKEKEEPER_CLIENT_SECRET})
  });
  if (!token.ok) throw new Error("internal token exchange failed");
  const body = await token.json();
  const res = await fetch(process.env.BELUGA_LAKEKEEPER_BASE_URL + "/catalog/v1/config?warehouse=lake", {
    headers: {Authorization: "Bearer " + body.access_token}, redirect: "error", signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error("internal catalog request failed");
  console.log("PASS: Manager pod -> internal Keycloak and Lakekeeper");
})().catch(() => { console.error("FAIL: internal reader path"); process.exit(1); });'
# Dedicated credential in a private file; never use a shared credential or ROPC.
kubectl -n platform-system get secret keycloak-manager-catalog-reader-secret -o jsonpath='{.data.manager-catalog-reader}' | base64 -d > "${TMP_DIR}/reader.secret"
run_curl -f --data-urlencode "client_secret@${TMP_DIR}/reader.secret" \
  -d client_id=manager-catalog-reader -d grant_type=client_credentials -d scope=openid \
  "https://sso.${BASE_DOMAIN}/realms/beluga/protocol/openid-connect/token" > "${TMP_DIR}/token.json"
CHECK_DIR="${TMP_DIR}" python3 - <<'PYCODE'
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
import uuid

root = Path(os.environ['CHECK_DIR'])
domain = os.environ['BASE_DOMAIN']
ip = os.environ.get('BELUGA_GATEWAY_IP', '127.0.0.1')
health = json.loads((root / 'health.json').read_text())
assert health['components']['lakekeeper'] == 'live', health['components']
# This also catches fixture completeness regressions after all overview sources are deployed.
assert health['components']['fixtures'] == 'live', health['components']
token = json.loads((root / 'token.json').read_text())['access_token']
(root / 'reader.header').write_text('Authorization: Bearer ' + token + '\n')


def request(host, path, reader=False, body=None):
    output = root / 'response.json'
    command = ['curl', '-sS', '--max-time', '30', '--cacert', str(root / 'ca.crt'),
               '--resolve', f'{host}.{domain}:443:{ip}', '-H', '@' + str(root / ('reader.header' if reader else 'manager.header')),
               '-o', str(output), '-w', '%{http_code}']
    if body is not None:
        command += ['-H', 'Content-Type: application/json', '--data-binary', json.dumps(body)]
    code = int(subprocess.check_output(command + [f'https://{host}.{domain}{path}'], text=True))
    return code, json.loads(output.read_text()) if output.read_text().strip() else {}


code, config = request('catalog', '/catalog/v1/config?warehouse=lake', True)
assert code == 200, code
prefix = config.get('overrides', {}).get('prefix', config.get('defaults', {}).get('prefix', ''))
base = '/catalog/v1' + ('/' + urllib.parse.quote(prefix, safe='') if prefix else '')


def listing(path, key, params=None):
    result = []
    query = dict(params or {})
    for _ in range(100):
        code, page = request('catalog', path + '?' + urllib.parse.urlencode(query), True)
        assert code == 200, (path, code)
        result += page[key]
        next_token = page.get('next-page-token')
        if not next_token:
            return result
        query['pageToken'] = next_token
    raise AssertionError('direct listing exceeded page limit')


queue = [[]]
namespaces = tables = 0
while queue:
    parent = queue.pop(0)
    children = listing(base + '/namespaces', 'namespaces', {'parent': '\x1f'.join(parent)} if parent else {})
    namespaces += len(children)
    queue.extend(children)
    assert namespaces < 10000, 'direct namespace traversal exceeded limit'
    if parent:
        tables += len(listing(base + '/namespaces/' + urllib.parse.quote('\x1f'.join(parent), safe='') + '/tables', 'identifiers'))
for kind, total in [('schema', namespaces), ('table', tables)]:
    code, overview = request('manager', f'/api/v1/data-assets?kind={kind}&pageSize=1')
    assert code == 200, (kind, code)
    assert not any(w['code'] == 'LISTING_TRUNCATED' for w in overview.get('warnings', []))
    assert overview['meta']['total'] == total, (kind, overview['meta']['total'], total)
    assert all(not any(key in row for key in ('columns', 'location', 'properties', 'storage-credentials')) for row in overview['data'])
    print(f'PASS: authenticated non-admin Manager {kind} count = direct catalog {total}')
# D-MCAT-7: a unique attempted name avoids collision masking an overprivileged identity.
# Cost: erroneous grants could create an empty namespace; escape hatch: authorized cleanup of reported name.
name = 'manager_reader_denial_' + uuid.uuid4().hex
code, _ = request('catalog', base + '/namespaces', True, {'namespace': [name]})
assert code == 403, f'FAIL: reader create expected 403, got {code}; inspect/clean namespace {name} if created'
print('PASS: reader namespace create denied (403), gateway and internal paths verified')
PYCODE
log_success "Manager Lakekeeper live assets checks passed."

#!/usr/bin/env bash
# Runtime smoke test for the local compose stack (manager/compose.yaml).
# manager-images.yml only builds the images; this starts them and proves the web container serves the
# rendered nginx.conf (CSP, SPA fallback) rather than the stock default.conf (#252). Also proves the
# inverse: without a writable conf.d the web image fails closed instead of serving the stock config.
# Uses its own compose project and a unique container name, so it never touches a developer's dev stack;
# it refuses to run if the fixed host ports are taken. Exit 2 = precondition, 1 = assertion failure.
# Run from anywhere: bash manager/scripts/ci/compose-smoke.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PROJECT="beluga-manager-smoke"
COMPOSE=(docker compose -p "${PROJECT}")
NEG_NAME="${PROJECT}-web-noconfd-$$"
WEB="http://127.0.0.1:5180"
API="http://127.0.0.1:8787"
NEG_PORT=5181
FAILED=1
STARTED=0

cleanup() {
  if [[ "${FAILED}" -ne 0 && "${STARTED}" -eq 1 ]]; then
    echo "--- compose logs ---" >&2
    "${COMPOSE[@]}" logs --no-color >&2 || true
    echo "--- negative container logs ---" >&2
    docker logs "${NEG_NAME}" >&2 || true
  fi
  docker rm -f "${NEG_NAME}" >/dev/null 2>&1 || true
  if [[ "${STARTED}" -eq 1 ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

for port in 5180 8787 "${NEG_PORT}"; do
  if port_busy "${port}"; then
    echo "refusing to run: 127.0.0.1:${port} is already in use (stop the dev stack first)" >&2
    exit 2
  fi
done

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }

echo "== positive: compose stack =="
STARTED=1
"${COMPOSE[@]}" up --build --wait -d

[[ "$(status "${WEB}/auth/callback")" == "200" ]] || fail "${WEB}/auth/callback is not 200 (stock default.conf?)"
[[ "$(status "${API}/api/v1/health")" == "200" ]] || fail "${API}/api/v1/health is not 200"

headers="$(curl -sS -D - -o /dev/null --max-time 5 "${WEB}/")"
for h in 'Content-Security-Policy:' 'Referrer-Policy: no-referrer' 'X-Content-Type-Options: nosniff'; do
  grep -iq "^${h}" <<<"${headers}" || fail "response header missing: ${h}"
done
# The SPA calls the Domain API cross-origin (public/config.json apiBaseUrl); the CSP must allow it.
grep -i '^Content-Security-Policy:' <<<"${headers}" | grep -Eq 'connect-src [^;]*http://localhost:8787' \
  || fail "CSP connect-src does not allow http://localhost:8787"
echo "ok: callback 200, security headers + connect-src present, API health 200"

echo "== negative: web image without a writable conf.d must not serve =="
docker run -d --name "${NEG_NAME}" \
  --user 101:101 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --tmpfs /var/cache/nginx:mode=1777 --tmpfs /run:mode=1777 --tmpfs /tmp:mode=1777 \
  -p "127.0.0.1:${NEG_PORT}:80" beluga-manager-web:dev >/dev/null

# Wait (bounded) until the entrypoint has finished and nginx itself is running, so a slow runner cannot
# pass the refusal check before nginx even started.
ready=0
for _ in $(seq 1 30); do
  if docker logs "${NEG_NAME}" 2>&1 | grep -q 'Configuration complete' \
    && docker exec "${NEG_NAME}" pgrep nginx >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "${ready}" -eq 1 ]] || fail "negative container never reached a running nginx within 30s"

for _ in 1 2 3; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${NEG_PORT}/auth/callback" || true)"
  [[ "${code}" == "000" ]] || fail "web served HTTP ${code} without conf.d; it must fail closed"
  sleep 1
done
echo "ok: web refuses to serve without the rendered config"

FAILED=0
echo "compose smoke: PASS"

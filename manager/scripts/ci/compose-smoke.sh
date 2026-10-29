#!/usr/bin/env bash
# Runtime smoke test for the local compose stack (manager/compose.yaml).
# manager-images.yml only builds the images; this starts them and proves the web container serves the
# rendered nginx.conf (CSP, SPA fallback) rather than the stock default.conf (#252). Also proves the
# inverse: without a writable conf.d the web image fails closed instead of serving the stock config.
# Run from anywhere: bash manager/scripts/ci/compose-smoke.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE=(docker compose)
WEB_IMAGE="beluga-manager-web:dev"
NEG_NAME="beluga-smoke-web-noconfd"
WEB="http://127.0.0.1:5180"
API="http://127.0.0.1:8787"
FAILED=1

cleanup() {
  if [[ "${FAILED}" -ne 0 ]]; then
    echo "--- compose logs ---" >&2
    "${COMPOSE[@]}" logs --no-color >&2 || true
    echo "--- negative container logs ---" >&2
    docker logs "${NEG_NAME}" >&2 || true
  fi
  docker rm -f "${NEG_NAME}" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }

echo "== positive: compose stack =="
"${COMPOSE[@]}" up --build --wait -d

[[ "$(status "${WEB}/auth/callback")" == "200" ]] || fail "${WEB}/auth/callback is not 200 (stock default.conf?)"
[[ "$(status "${API}/api/v1/health")" == "200" ]] || fail "${API}/api/v1/health is not 200"

headers="$(curl -sS -D - -o /dev/null --max-time 5 "${WEB}/")"
for h in 'Content-Security-Policy:' 'Referrer-Policy: no-referrer' 'X-Content-Type-Options: nosniff'; do
  grep -iq "^${h}" <<<"${headers}" || fail "response header missing: ${h}"
done
echo "ok: callback 200, security headers present, API health 200"

echo "== negative: web image without a writable conf.d must not serve =="
docker run -d --name "${NEG_NAME}" \
  --user 101:101 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --tmpfs /var/cache/nginx:mode=1777 --tmpfs /run:mode=1777 --tmpfs /tmp:mode=1777 \
  -p 127.0.0.1:5181:80 "${WEB_IMAGE}" >/dev/null
sleep 5
# Fail closed: nothing may answer on the published port (no stock default.conf fallback).
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:5181/auth/callback" || true)"
[[ "${code}" == "000" ]] || fail "web served HTTP ${code} without conf.d; it must fail closed"
echo "ok: web refuses to serve without the rendered config"

FAILED=0
echo "compose smoke: PASS"

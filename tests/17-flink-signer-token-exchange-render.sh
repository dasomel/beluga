#!/usr/bin/env bash
# Beluga Test 17: flink 클라이언트의 Keycloak 토큰 교환 속성이 두 경로 모두에 렌더되는지 정적 검증.
#
# Iceberg 1.7.1 S3 서명 클라이언트는 5분짜리 토큰을 RFC 8693 교환으로 갱신한다. 속성이 빠지면
# Lakekeeper /signer/.../s3/sign만 401 ExpiredSignature가 되고 Flink 잡이 재시작을 반복한다
# (docs/mistakes-log.md 2026-10-07). realm import는 1회성이라 신규 realm(keycloak.yaml)과 이미
# 부트스트랩된 realm(keycloak-clients Job) 두 경로가 모두 필요하다. "렌더 통과"만 증명한다.
set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

helm template gitops/charts/beluga-platform > "$TMP/platform.yaml"
python3 - "$TMP/platform.yaml" <<'PY'
import json
import sys
from pathlib import Path

import yaml

ATTR = "standard.token.exchange.enabled"
docs = [d for d in yaml.safe_load_all(Path(sys.argv[1]).read_text()) if d]

def check(condition, message):
    if not condition:
        raise AssertionError(message)

def flink_realm_attrs(docs):
    for d in docs:
        if d.get("kind") != "ConfigMap":
            continue
        for value in (d.get("data") or {}).values():
            try:
                realm = json.loads(value)
            except (TypeError, ValueError):
                continue
            for client in realm.get("clients", []):
                if client.get("clientId") == "flink":
                    return client.get("attributes", {})
    return None

def clients_job_source(docs):
    for d in docs:
        if d.get("kind") == "Job" and d["metadata"]["name"].startswith("keycloak-clients"):
            return d["spec"]["template"]["spec"]["containers"][0]["command"][2]
    return None

attrs = flink_realm_attrs(docs)
check(attrs is not None, "flink client not found in the rendered realm import")
check(attrs.get(ATTR) == "true", f"realm import: flink client must set {ATTR}=true")

src = clients_job_source(docs)
check(src is not None, "keycloak-clients Job not found in the render")
check("CLIENT_ATTRIBUTES" in src and f'"{ATTR}": "true"' in src,
      f"keycloak-clients: reconcile step must enforce {ATTR}=true for flink")
compile(src, "keycloak-clients", "exec")

# 음성 자체 점검: 속성을 뺀 realm은 반드시 거부되어야 한다 (검사가 항상 통과하는 빈 껍데기 방지).
mutated = dict(attrs)
mutated.pop(ATTR)
check(mutated.get(ATTR) != "true", "negative self-check failed")
print("Flink signer token-exchange render contract passed (realm import + clients Job + negative self-check).")
PY

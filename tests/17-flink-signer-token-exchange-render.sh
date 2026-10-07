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
import ast
import copy
import json
import sys
from pathlib import Path

import yaml

ATTR = "standard.token.exchange.enabled"
docs = [d for d in yaml.safe_load_all(Path(sys.argv[1]).read_text()) if d]

def check(condition, message):
    if not condition:
        raise AssertionError(message)

def realm_flink_attrs(docs):
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

def job_client_attributes(src):
    """Job 스크립트의 CLIENT_ATTRIBUTES 리터럴을 AST로 파싱해 값 그대로 돌려준다."""
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "CLIENT_ATTRIBUTES" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    return None

def assert_realm_import(docs):
    attrs = realm_flink_attrs(docs)
    check(attrs is not None, "flink client not found in the rendered realm import")
    check(attrs.get(ATTR) == "true", f"realm import: flink client must set {ATTR}=true")

def assert_clients_job(src):
    check(src is not None, "keycloak-clients Job not found in the render")
    parsed = job_client_attributes(src)
    check(parsed is not None, "keycloak-clients: CLIENT_ATTRIBUTES not found")
    check(parsed.get("flink", {}).get(ATTR) == "true",
          f"keycloak-clients: CLIENT_ATTRIBUTES must map flink -> {ATTR}=true")

def must_fail(fn, arg, label):
    try:
        fn(arg)
    except AssertionError:
        return
    raise AssertionError(f"negative self-check failed: {label} was accepted")

src = clients_job_source(docs)
assert_realm_import(docs)
assert_clients_job(src)
compile(src, "keycloak-clients", "exec")

# 음성 자체 점검: 실제 판정 함수에 변형 입력을 넣어 반드시 거부되는지 확인한다.
no_attr = copy.deepcopy(docs)
for d in no_attr:
    if d.get("kind") == "ConfigMap":
        for k, v in (d.get("data") or {}).items():
            try:
                realm = json.loads(v)
            except (TypeError, ValueError):
                continue
            for c in realm.get("clients", []):
                if c.get("clientId") == "flink":
                    c.get("attributes", {}).pop(ATTR, None)
            d["data"][k] = json.dumps(realm)
must_fail(assert_realm_import, no_attr, "realm import without the attribute")
must_fail(assert_clients_job, src.replace('"flink": {"standard', '"trino": {"standard'), "job targeting the wrong client")
must_fail(assert_clients_job, src.replace('"true"}', '"false"}', 1), "job with the attribute disabled")
print("Flink signer token-exchange render contract passed (realm import + clients Job AST + negative self-checks).")
PY

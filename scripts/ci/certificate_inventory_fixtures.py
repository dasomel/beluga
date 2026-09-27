"""Built-in positive/negative fixtures; run on every certificate gate invocation."""
from copy import deepcopy


def self_test(documents, inventory, duration, profile_inventories):
    baseline = documents("""
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: {name: ca}
spec: {selfSigned: {}}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: {name: server, namespace: apps}
spec:
  secretName: server-tls
  dnsNames: [example.test]
  duration: 2160h
  renewBefore: 720h
  issuerRef: {name: ca, kind: ClusterIssuer}
---
apiVersion: apisix.apache.org/v2
kind: ApisixTls
metadata: {name: edge, namespace: edge}
spec:
  hosts: [example.test]
  secret: {name: server-tls, namespace: apps}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: server, namespace: apps}
spec:
  template:
    spec:
      containers:
        - name: server
          volumeMounts: [{name: identity, mountPath: /identity}]
      volumes: [{name: identity, secret: {secretName: server-tls}}]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: ingress, namespace: apps}
spec:
  tls: [{hosts: [example.test], secretName: server-tls}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {name: gateway, namespace: edge}
spec:
  listeners:
    - name: https
      protocol: HTTPS
      hostname: example.test
      tls:
        certificateRefs: [{name: server-tls, namespace: apps}]
""")
    if len(inventory(baseline)["certificates"][0]["consumers"]) != 4:
        raise ValueError("self-test: positive fixture lost a TLS consumer")
    if duration("1h30m0.5s") != duration("5400.5s"):
        raise ValueError("self-test: composite duration parsed incorrectly")
    negative_count = 0

    def rejected(label, resources, expected):
        nonlocal negative_count
        try:
            inventory(resources)
        except ValueError as exc:
            if expected not in str(exc):
                raise ValueError(f"self-test {label}: unexpected error: {exc}") from exc
            negative_count += 1
        else:
            raise ValueError(f"self-test {label}: unsafe fixture passed")

    for field in ("duration", "renewBefore", "dnsNames", "secretName", "issuerRef"):
        broken = deepcopy(baseline)
        del broken[1]["spec"][field]
        rejected(f"missing {field}", broken, field)
    # A broken Certificate only present in the optional profile must still fail
    # the same all-profile gate used for rendered production manifests.
    optional_profile = deepcopy(baseline)
    del optional_profile[1]["spec"]["renewBefore"]
    try:
        profile_inventories({"32": baseline, "48": optional_profile})
    except ValueError as exc:
        if "profile 48" not in str(exc) or "renewBefore" not in str(exc):
            raise ValueError(f"self-test non-default profile: unexpected error: {exc}") from exc
        negative_count += 1
    else:
        raise ValueError("self-test non-default profile: missing renewBefore passed")
    for value in ("2160h", "2161h", "0h", "-1h", "30d", "4m", "nonsense", 720):
        broken = deepcopy(baseline)
        broken[1]["spec"]["renewBefore"] = value
        rejected(f"invalid renewal {value}", broken, "Certificate/apps/server")
    for patch in ({"name": "absent"}, {"kind": "Issuer"}, {"group": "external.test"}):
        broken = deepcopy(baseline)
        broken[1]["spec"]["issuerRef"].update(patch)
        rejected(f"invalid issuer {patch}", broken, "missing/unsupported issuer")
    for index in (0, 1):
        rejected("missing issuer/certificate", baseline[:index] + baseline[index + 1:],
                 "missing/unsupported issuer" if index == 0 else "has no valid Certificate")
    broken = deepcopy(baseline)
    broken[1]["metadata"]["namespace"] = "elsewhere"
    rejected("wrong certificate namespace", broken, "has no valid Certificate")
    broken = deepcopy(baseline)
    broken[1]["apiVersion"] = "fake.io/v1"
    rejected("fake Certificate API", broken, "expected cert-manager.io/v1")
    rejected("duplicate resource", baseline + [baseline[1]], "duplicate resource")
    broken = deepcopy(baseline)
    another = deepcopy(baseline[1])
    another["metadata"]["name"] = "competing"
    rejected("duplicate Secret ownership", broken + [another], "multiple Certificates")
    broken = deepcopy(baseline)
    broken[1]["spec"]["dnsNames"] = ["other.test"]
    rejected("mismatched host", broken, "hostnames are not covered")
    good = deepcopy(baseline)
    good[1]["spec"]["dnsNames"] = ["*.test"]
    inventory(good)
    good[2]["spec"]["hosts"] = ["nested.example.test"]
    rejected("wildcard depth", good, "hostnames are not covered")
    for field in ("data", "stringData"):
        secret = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "manual"},
                  "type": "kubernetes.io/tls", field: {"tls.crt": "Y2VydA=="}}
        rejected(f"inline {field}", baseline + [secret], "inline TLS")
        secret["type"] = "Opaque"
        rejected(f"disguised inline {field}", baseline + [secret], "inline TLS")
    for index in (2, 4, 5):
        broken = deepcopy(baseline)
        spec = broken[index]["spec"]
        if index == 2:
            del spec["secret"]
        elif index == 4:
            del spec["tls"][0]["secretName"]
        else:
            del spec["listeners"][0]["tls"]["certificateRefs"]
        rejected("missing TLS ref", broken, "invalid/uninventoried TLS reference")
    for patch in ({"certificateRefs": []}, {"mode": "Passthrough"},
                  {"certificateRefs": [{"name": "server-tls", "kind": "ConfigMap"}]},
                  {"certificateRefs": [{"name": "server-tls", "namespace": "wrong"}]}):
        broken = deepcopy(baseline)
        broken[5]["spec"]["listeners"][0]["tls"].update(patch)
        rejected("invalid Gateway ref", broken, "Gateway/edge/gateway")

    for projected in (False, True):
        good = deepcopy(baseline)
        volume = good[3]["spec"]["template"]["spec"]["volumes"][0]
        if projected:
            del volume["secret"]
            volume["projected"] = {"sources": [{"secret": {"name": "server-tls"}}]}
        inventory(good)
        if projected:
            volume["projected"]["sources"][0]["secret"]["name"] = "unclassified"
        else:
            volume["secret"]["secretName"] = "unclassified"
        rejected("unclassified mounted Secret", good, "Secret/apps/unclassified")

    for container_key in ("containers", "initContainers", "ephemeralContainers"):
        for env in ({"env": [{"name": "SERVER_CERT", "valueFrom": {
                "secretKeyRef": {"name": "missing", "key": "identity"}}}]},
                    {"env": [{"name": "IDENTITY", "valueFrom": {
                        "secretKeyRef": {"name": "missing", "key": "value"}}}]},
                    {"envFrom": [{"secretRef": {"name": "missing"}}]}):
            broken = deepcopy(baseline)
            pod = broken[3]["spec"]["template"]["spec"]
            pod[container_key] = [{"name": "reader", **env}]
            rejected("env certificate", broken, "Secret/apps/missing")

    good = deepcopy(baseline)
    good[3]["metadata"]["namespace"] = "analytics"
    good[3]["spec"]["template"]["spec"] = {"containers": [{"name": "client", "env": [{
        "name": "KEYSTORE_PASSWORD", "valueFrom": {
            "secretKeyRef": {"name": "trino-keystore-password", "key": "password"}}}]}]}
    inventory(good)
    ref = good[3]["spec"]["template"]["spec"]["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"]
    ref["key"] = "identity"
    rejected("unclassified bootstrap key", good, "Secret/analytics/trino-keystore-password")

    # Pod, CronJob and operator CRs embed the same Pod spec at different depths.
    for kind, wrapper in (("Pod", lambda pod: pod),
                          ("CronJob", lambda pod: {"jobTemplate": {"spec": {"template": {"spec": pod}}}}),
                          ("FlinkDeployment", lambda pod: {"podTemplate": {"spec": pod}})):
        good = deepcopy(baseline)
        pod = good[3]["spec"]["template"]["spec"]
        good[3]["kind"], good[3]["spec"] = kind, wrapper(pod)
        inventory(good)
        pod["volumes"][0]["secret"]["secretName"] = "missing"
        rejected(f"{kind} certificate", good, "Secret/apps/missing")

    good = deepcopy(baseline)
    good[0]["kind"] = "Issuer"
    good[0]["metadata"]["namespace"] = "apps"
    good[1]["spec"]["issuerRef"].pop("kind")
    good[1]["spec"]["commonName"] = good[1]["spec"].pop("dnsNames")[0]
    inventory(good)
    good[0]["metadata"]["namespace"] = "wrong"
    rejected("namespaced issuer isolation", good, "missing/unsupported issuer")
    for malformed in ("", "[]", "kind: Secret\nkind: Certificate", "metadata: {}", "null"):
        try:
            documents(malformed)
        except (ValueError, KeyError, TypeError):
            negative_count += 1
        else:
            raise ValueError("self-test: empty/malformed YAML passed")
    return negative_count

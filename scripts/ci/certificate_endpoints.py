"""TLS Secret references in rendered ingress resources and embedded Pod specs."""
import re


# D3: Only these bootstrap-created, individual credential keys are exempt from
# resolving to a rendered Secret/Certificate. Unknown keys fail closed, even if
# named innocuously. Cost: update this list when bootstrap credentials change;
# escape hatch: render the non-TLS Secret instead. Source: 01-argocd-bootstrap.sh.
BOOTSTRAP_KEYS = {
    "postgres-admin-credential": ("database governance streaming lakehouse orchestration analytics", "username password"),
    "keycloak-admin-credential": ("iam", "username password"),
    "keycloak-db-credential": ("iam", "username password"),
    "trino-keystore-password": ("analytics", "password"),
    "ldap-admin-credential": ("iam", "password"),
    "ldap-reader-credential": ("iam analytics", "username password"),
    "trino-ldap-service-credential": ("iam analytics", "username password"),
    "keycloak-user-passwords": ("iam", "admin engineer analyst"),
    "keycloak-client-secrets": ("iam analytics orchestration governance", "superset airflow openmetadata grafana trino"),
    "superset-credential": ("analytics", "secret-key admin-password"),
    "apisix-admin-credential": ("platform-system", "key"),
    "trino-internal-shared-secret": ("analytics", "secret"),
    "seaweedfs-s3-credentials": ("storage", "trino-access-key trino-secret-key flink-access-key flink-secret-key lakekeeper-access-key lakekeeper-secret-key"),
    "trino-s3-credential": ("analytics", "access-key secret-key"),
    "flink-s3-credential": ("streaming", "access-key secret-key"),
    "lakekeeper-s3-credential": ("lakehouse", "access-key secret-key"),
}


def mappings(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from mappings(child)


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected a non-empty string")
    return value


def names(value):
    return [text(item) for item in sequence(value)]


def sequence(value):
    if not isinstance(value, list):
        raise ValueError("expected a list")
    return value


def tls_hint(value):
    # Passwords protect keystores but are not certificates themselves.
    value = str(value).lower()
    return "password" not in value and bool(re.search(
        r"tls|ssl|cert|keystore|private.?key|\.(?:crt|pem|p12|pfx|jks)(?:\b|$)", value,
    ))


def references(resource, certificates, secrets):
    """Yield (namespace, Secret name, field/purpose, hostnames).

    Unknown Secrets fail closed: their contents cannot be classified offline.
    Only explicitly listed bootstrap credential keys can be external.
    """
    namespace = resource["metadata"].get("namespace", "default")
    spec = resource.get("spec", {})
    kind = resource["kind"]
    if kind == "ApisixTls":
        ref = spec["secret"]
        hosts = names(spec["hosts"])
        if not hosts:
            raise ValueError("ApisixTls requires hosts")
        yield text(ref.get("namespace", namespace)), text(ref["name"]), "spec.secret", hosts
    elif kind == "Ingress":
        for i, tls in enumerate(sequence(spec.get("tls", []))):
            yield namespace, text(tls["secretName"]), f"spec.tls[{i}]", names(tls.get("hosts", []))
    elif kind == "Gateway":
        for listener in sequence(spec["listeners"]):
            if listener.get("protocol") not in ("HTTPS", "TLS") and "tls" not in listener:
                continue
            tls = listener["tls"]
            # D1: A passthrough backend cannot be proven by a listener-local
            # reference. Reject it; supporting it requires route/backend tracing.
            if tls.get("mode", "Terminate") != "Terminate":
                raise ValueError("Gateway TLS passthrough/unknown mode is not inventoried")
            refs = tls["certificateRefs"]
            if not isinstance(refs, list) or not refs:
                raise ValueError("Gateway TLS listener requires certificateRefs")
            for ref in refs:
                if ref.get("group", "") != "" or ref.get("kind", "Secret") != "Secret":
                    raise ValueError("Gateway certificateRef must reference a core Secret")
                yield (text(ref.get("namespace", namespace)), text(ref["name"]),
                       f"listener/{text(listener['name'])}",
                       names([listener["hostname"]]) if "hostname" in listener else [])

    def workload_ref(ref, field, hints, whole_secret=False):
        name = text(ref.get("secretName", ref.get("name")))
        key = (namespace, name)
        secret = secrets.get(key)
        namespaces, keys = BOOTSTRAP_KEYS.get(name, ("", ""))
        credential = (not whole_secret and namespace in namespaces.split()
                      and ref.get("key") in keys.split())
        if (key in certificates or tls_hint(name) or any(tls_hint(hint) for hint in hints)
                or secret and secret.get("type") == "kubernetes.io/tls"
                or secret is None and not credential):
            return namespace, name, field, []
        return None

    for pod in mappings(spec):
        if "containers" not in pod:
            continue
        containers = sum((pod.get(key, []) for key in
                          ("containers", "initContainers", "ephemeralContainers")), [])
        for volume in pod.get("volumes", []):
            hints = [volume["name"]]
            for container in containers:
                hints.extend(mount.get("mountPath", "") for mount in container.get("volumeMounts", [])
                             if mount["name"] == volume["name"])
            sources = ([volume] if "secret" in volume else [])
            sources += volume.get("projected", {}).get("sources", [])
            for source in sources:
                if "secret" in source:
                    ref = source["secret"]
                    item_hints = [value for item in ref.get("items", []) for value in item.values()]
                    found = workload_ref(ref, f"volume/{volume['name']}", hints + item_hints, True)
                    if found:
                        yield found
        for container in containers:
            for env in container.get("env", []):
                ref = env.get("valueFrom", {}).get("secretKeyRef")
                if ref is not None:
                    found = workload_ref(ref, f"env/{text(env['name'])}", [env["name"], text(ref["key"])])
                    if found:
                        yield found
            for env in container.get("envFrom", []):
                if "secretRef" in env:
                    found = workload_ref(env["secretRef"], "envFrom", [], True)
                    if found:
                        yield found

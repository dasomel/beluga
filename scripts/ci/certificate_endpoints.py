"""TLS Secret references in rendered ingress resources and embedded Pod specs."""
import re


# D3: Only these bootstrap-created, individual credential keys are exempt from
# resolving to a rendered Secret/Certificate. Unknown keys fail closed, even if
# named innocuously. Cost: update this list when bootstrap credentials change;
# escape hatch: render the non-TLS Secret instead. Source: 01-argocd-bootstrap.sh.
BOOTSTRAP_KEYS = {
    "postgres-admin-credential": ("database governance streaming lakehouse orchestration analytics", "username password"),
    "openfga-db-credential": ("iam", "password"),
    "openfga-authn-credential": ("iam lakehouse", "keys key"),
    "keycloak-admin-credential": ("iam", "username password"),
    "keycloak-db-credential": ("iam", "username password"),
    "trino-keystore-password": ("analytics", "password"),
    "ldap-admin-credential": ("iam", "password"),
    "ldap-reader-credential": ("iam analytics", "username password"),
    "trino-ldap-service-credential": ("iam analytics", "username password"),
    "keycloak-user-passwords": ("iam", "admin engineer analyst"),
    "keycloak-client-secrets": ("iam analytics orchestration governance", "superset airflow openmetadata grafana trino"),
    "keycloak-flink-client-secret": ("iam streaming", "flink"),
    "keycloak-lakekeeper-admin-secret": ("iam lakehouse", "lakekeeper-admin"),
    "keycloak-apisix-client-secret": ("iam", "apisix-gateway"),
    "keycloak-argocd-client-secret": ("iam", "argocd"),
    "superset-credential": ("analytics", "secret-key admin-password"),
    "apisix-admin-credential": ("platform-system", "key"),
    "apisix-oidc-credential": ("platform-system", "client-secret session-secret"),
    "trino-internal-shared-secret": ("analytics", "secret"),
    "seaweedfs-s3-credentials": ("storage", "trino-access-key trino-secret-key flink-access-key flink-secret-key lakekeeper-access-key lakekeeper-secret-key postgres-backup-access-key postgres-backup-secret-key postgres-backup-admin-access-key postgres-backup-admin-secret-key"),
    "postgres-backup-provisioner-credential": ("storage", "access-key secret-key"),
    "trino-s3-credential": ("analytics", "access-key secret-key"),
    "flink-s3-credential": ("streaming", "access-key secret-key"),
    "lakekeeper-s3-credential": ("lakehouse", "access-key secret-key"),
    "postgres-backup-s3-credential": ("database", "access-key secret-key"),
    # D-MSSO-11b: 감사 DB 롤 비밀번호(01-argocd-bootstrap.sh ensure_manager_db_secrets).
    "manager-db-owner": ("platform-system", "username password"),
    "manager-db-writer": ("platform-system", "username password"),
    # D-MSSO-15: GitHub App 식별자(소유자가 만든 Secret, Git 밖). 개인 키(private-key.pem)는 인증서가 아니라
    # 아래 OWNER_PROVIDED_APP_KEY로만 면제한다.
    "manager-github-app": ("platform-system", "app-id installation-id"),
}

# D-MSSO-11d: CNPG 오퍼레이터가 만든 클러스터 CA Secret(<cluster>-ca: ca.crt + ca.key). cert-manager
# Certificate가 아니라 렌더에 나타나지 않지만, 수명은 오퍼레이터가 관리한다(90일, 만료 7일 전 자동 갱신 —
# https://cloudnative-pg.io/documentation/1.30/certificates/). 클라이언트는 ca.crt만 신뢰 앵커로 읽는다.
# 면제는 정확한 (네임스페이스, 이름)이면서 items로 ca.crt만 투영한(whole_secret=False) 참조에만 적용된다.
# Secret 전체 마운트(ca.key 노출)나 다른 키 투영은 면제되지 않아 미분류 Secret으로 실패한다.
# 새 항목은 이 목록을 고쳐야 한다. manager-db-writer(비밀번호 Secret)는 여기가 아니라 BOOTSTRAP_KEYS로 처리한다.
OPERATOR_MANAGED_CA_SECRETS = {("platform-system", "manager-db-ca")}

# D-MSSO-15: GitHub App 개인 키는 TLS 인증서가 아니다(GitHub가 발급, 소유자가 Secret으로 주입, JWT 서명 전용).
# 이름 힌트(private-key.pem)로 오탐되므로 정확한 (네임스페이스, 이름)이면서 items로 private-key.pem만 투영한
# 참조에만 면제한다. Secret 전체 마운트나 다른 키 투영은 면제되지 않는다.
OWNER_PROVIDED_APP_KEY = {("platform-system", "manager-github-app")}


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
    def workload_ref(ref, field, hints, whole_secret=False, item_keys=None):
        name = text(ref.get("secretName", ref.get("name")))
        key = (namespace, name)
        if key in OPERATOR_MANAGED_CA_SECRETS and not whole_secret and item_keys == ["ca.crt"]:
            return None
        if key in OWNER_PROVIDED_APP_KEY and not whole_secret and item_keys == ["private-key.pem"]:
            return None
        secret = secrets.get(key)
        namespaces, keys = BOOTSTRAP_KEYS.get(name, ("", ""))
        key_list = item_keys or [ref.get("key")]
        credential = (not whole_secret and namespace in namespaces.split()
                      and all(k in keys.split() for k in key_list))
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
                    items = ref.get("items") or []
                    found = workload_ref(ref, f"volume/{volume['name']}", hints + item_hints,
                                         not items, [item["key"] for item in items])
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

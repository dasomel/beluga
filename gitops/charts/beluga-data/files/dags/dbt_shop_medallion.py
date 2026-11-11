"""Build governed shop Silver/Gold tables with the dbt service identity."""

from datetime import datetime, timedelta, timezone

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator
from kubernetes.client import models as k8s

# D-DBT-10: fetch once, then replace Python with dbt; never print credentials.
# Cost: a run must finish within the token lifetime; escape hatch: reviewed refresh.
# D-DBT-11: explicit openid enables default Trino UserInfo validation.
# Cost: UserInfo must be reachable; escape hatch: repair that path, retain validation.
BOOTSTRAP = """
import os
import requests

response = requests.post(
    'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token',
    data={'grant_type': 'client_credentials', 'client_id': 'dbt', 'scope': 'openid',
          'client_secret': os.environ.pop('DBT_CLIENT_SECRET')},
    timeout=30,
)
response.raise_for_status()
os.environ['DBT_ENV_SECRET_TRINO_JWT'] = response.json()['access_token']
os.execvp('dbt', ['dbt', 'build', '--target', 'trino', '--project-dir', '/opt/beluga/dbt'])
"""

with DAG(
    "dbt_shop_medallion",
    description="Build and test shop Silver/Gold tables on Trino/Iceberg",
    start_date=datetime(2026, 11, 10, tzinfo=timezone.utc),
    schedule="@daily",
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    default_args={"owner": "beluga", "retries": 0},
) as dag:
    build = KubernetesPodOperator(
        task_id="dbt_build",
        name="dbt-shop-medallion",
        namespace="analytics",
        # Deployment image: ghcr.io/dasomel/beluga-dbt:sha-aa5091c21f1eec615ce8f04621b0a9b7445eefd9
        # Keep the inventory tag visible to the rendered VERSIONS.md checker.
        image="ghcr.io/dasomel/beluga-dbt:sha-aa5091c21f1eec615ce8f04621b0a9b7445eefd9@sha256:180ee3da4eb2598c6d6267523a8f9554ee40cce02221bd1821082c74b2df58cc",
        cmds=["python", "-c"],
        arguments=[BOOTSTRAP],
        env_vars=[
            k8s.V1EnvVar(name="DBT_TARGET", value="trino"),
            k8s.V1EnvVar(name="DBT_TRINO_HOST", value="trino.analytics.svc.cluster.local"),
            k8s.V1EnvVar(name="DBT_TRINO_PORT", value="8443"),
            k8s.V1EnvVar(name="DBT_TRINO_HTTP_SCHEME", value="https"),
            k8s.V1EnvVar(name="DBT_TRINO_USER", value="svc-dbt"),
            k8s.V1EnvVar(name="DBT_PROFILES_DIR", value="/opt/beluga/dbt"),
            k8s.V1EnvVar(name="DBT_SEND_ANONYMOUS_USAGE_STATS", value="False"),
            # D-DBT-16: KPO templates V1EnvVar.value; bind audit rows to this run.
            # Cost: Airflow run-id coupling; escape hatch: manual defaults outside KPO.
            k8s.V1EnvVar(name="BELUGA_ORCHESTRATOR_RUN_ID", value="{{ run_id }}"),
            k8s.V1EnvVar(name="DBT_CLIENT_SECRET", value_from=k8s.V1EnvVarSource(
                secret_key_ref=k8s.V1SecretKeySelector(name="keycloak-dbt-client-secret", key="dbt"),
            )),
            # D-DBT-10: requests (Trino transport) honors this without an image rebuild.
            # Cost: internal CA only; escape hatch: merge public roots if egress is added.
            k8s.V1EnvVar(name="REQUESTS_CA_BUNDLE", value="/etc/internal-ca/ca.crt"),
            k8s.V1EnvVar(name="SSL_CERT_FILE", value="/etc/internal-ca/ca.crt"),
            # D-DBT-14: dbt-trino verifies TLS only through its own `cert` setting.
            k8s.V1EnvVar(name="DBT_TRINO_CERT", value="/etc/internal-ca/ca.crt"),
        ],
        volumes=[k8s.V1Volume(name="internal-ca", config_map=k8s.V1ConfigMapVolumeSource(
            name="beluga-internal-ca",
        ))],
        volume_mounts=[k8s.V1VolumeMount(
            name="internal-ca", mount_path="/etc/internal-ca", read_only=True,
        )],
        in_cluster=True,
        get_logs=True,
        log_pod_spec_on_failure=False,
        on_finish_action="delete_pod",
        startup_timeout_seconds=300,
        execution_timeout=timedelta(minutes=30),
    )

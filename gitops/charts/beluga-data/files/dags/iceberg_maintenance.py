"""Run scoped Iceberg table procedures with a dedicated service identity."""

from datetime import datetime, timedelta, timezone

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator
from kubernetes.client import models as k8s

# D-MAINT-3: mint once per pod and verify Trino TLS; never print credentials.
# Cost: token must outlive this run; escape hatch: reviewed token refresh.
BOOTSTRAP = """
import os
import requests
from trino.auth import JWTAuthentication
from trino.dbapi import connect
from trino.exceptions import TrinoUserError

response = requests.post(
    'http://keycloak.iam.svc.cluster.local:8080/realms/beluga/protocol/openid-connect/token',
    data={'grant_type': 'client_credentials', 'client_id': 'maintenance', 'scope': 'openid',
          'client_secret': os.environ.pop('MAINTENANCE_CLIENT_SECRET')},
    timeout=30,
)
response.raise_for_status()
connection = connect(
    host='trino.analytics.svc.cluster.local', port=8443, http_scheme='https',
    user='svc-maintenance', auth=JWTAuthentication(response.json()['access_token']),
    verify='/etc/internal-ca/ca.crt',
)
# D-MAINT-2: keep this exact list aligned with policies/resources.yaml.
# Cost: explicit inventory; escape hatch: reviewed table additions.
for table in ('lake.orders', 'lake.customers', 'lake.events_enriched',
              'silver_shop.orders', 'gold_shop.daily_revenue'):
    cursor = connection.cursor()
    try:
        for procedure in ('optimize', "expire_snapshots(retention_threshold => '7d')"):
            cursor.execute(f'ALTER TABLE iceberg.{table} EXECUTE {procedure}')
            cursor.fetchall()
    except TrinoUserError as error:
        # D-MAINT-4: fresh clusters may not have dbt outputs yet.
        # Cost: missing tables wait for the next run; escape hatch: require them after adoption.
        if error.error_name != 'TABLE_NOT_FOUND':
            raise
        print(f'SKIP: iceberg.{table}: TABLE_NOT_FOUND')
    finally:
        cursor.close()
connection.close()
"""

with DAG(
    "iceberg_table_maintenance",
    description="Compact Iceberg tables and expire snapshots with scoped procedures",
    start_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
    schedule="@hourly",
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    default_args={"owner": "beluga", "retries": 1, "retry_delay": timedelta(minutes=5)},
) as dag:
    maintenance = KubernetesPodOperator(
        task_id="iceberg_maintenance",
        name="iceberg-maintenance",
        namespace="analytics",
        # Deployment image: ghcr.io/dasomel/beluga-dbt:sha-2af38b5ed0f76a8f66e822ff1553b45671ad201a
        image="ghcr.io/dasomel/beluga-dbt:sha-2af38b5ed0f76a8f66e822ff1553b45671ad201a@sha256:09df094a8f83d3dc728607ad949c9ef6abdb1a030865eb0fcd681c3e9ec6d81a",
        cmds=["python", "-c"],
        arguments=[BOOTSTRAP],
        env_vars=[k8s.V1EnvVar(
            name="MAINTENANCE_CLIENT_SECRET", value_from=k8s.V1EnvVarSource(
                secret_key_ref=k8s.V1SecretKeySelector(
                    name="keycloak-maintenance-client-secret", key="maintenance",
                ),
            ),
        )],
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

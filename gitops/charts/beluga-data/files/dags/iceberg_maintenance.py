"""Airflow DAG: Iceberg Table Maintenance (Compaction & Snapshot Expiration)."""

from datetime import datetime, timedelta
from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator

default_args = {
    "owner": "beluga",
    "depends_on_past": False,
    "start_date": datetime(2026, 8, 1),
    "email_on_failure": False,
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    "iceberg_table_maintenance",
    default_args=default_args,
    description="Compacts Iceberg small files and expires old snapshots",
    schedule="@hourly",  # Airflow 3: schedule_interval 제거됨 (parse error 실측)
    catchup=False,
) as dag:

    iceberg_compaction = KubernetesPodOperator(
        namespace="beluga-data",
        image="trinodb/trino:483",
        cmds=["trino"],
        arguments=[
            "--server", "http://trino:8080",
            "--execute", "ALTER TABLE iceberg.lake.events_enriched EXECUTE optimize; ALTER TABLE iceberg.lake.orders EXECUTE optimize;"
        ],
        name="iceberg-compaction-task",
        task_id="iceberg_compaction",
        on_finish_action="delete_pod",  # provider 8+: is_delete_operator_pod 대체
        hostnetwork=False,
    )

    snapshot_expiration = KubernetesPodOperator(
        namespace="beluga-data",
        image="trinodb/trino:483",
        cmds=["trino"],
        arguments=[
            "--server", "http://trino:8080",
            "--execute", "ALTER TABLE iceberg.lake.events_enriched EXECUTE expire_snapshots(retention_threshold => '7d');"
        ],
        name="snapshot-expiration-task",
        task_id="snapshot_expiration",
        on_finish_action="delete_pod",  # provider 8+: is_delete_operator_pod 대체
        hostnetwork=False,
    )

    iceberg_compaction >> snapshot_expiration

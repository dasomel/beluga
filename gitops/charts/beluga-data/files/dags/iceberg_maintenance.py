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
    schedule_interval="@hourly",
    catchup=False,
) as dag:

    iceberg_compaction = KubernetesPodOperator(
        namespace="beluga-data",
        image="trinodb/trino:468",
        cmds=["trino"],
        arguments=[
            "--server", "http://trino:8080",
            "--execute", "ALTER TABLE iceberg.lake.events_enriched EXECUTE optimize; ALTER TABLE iceberg.lake.orders EXECUTE optimize;"
        ],
        name="iceberg-compaction-task",
        task_id="iceberg_compaction",
        is_delete_operator_pod=True,
        hostnetwork=False,
    )

    snapshot_expiration = KubernetesPodOperator(
        namespace="beluga-data",
        image="trinodb/trino:468",
        cmds=["trino"],
        arguments=[
            "--server", "http://trino:8080",
            "--execute", "ALTER TABLE iceberg.lake.events_enriched EXECUTE expire_snapshots(retention_threshold => '7d');"
        ],
        name="snapshot-expiration-task",
        task_id="snapshot_expiration",
        is_delete_operator_pod=True,
        hostnetwork=False,
    )

    iceberg_compaction >> snapshot_expiration

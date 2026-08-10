# Flink SQL files

This directory previously held SQL scripts for Flink jobs.
The SQL files have been moved to `gitops/charts/beluga-data/files/flink-sql/` to enable Helm chart packaging via `.Files.Get` and automated Job submission.

- `events_sessionization.sql` -> `gitops/charts/beluga-data/files/flink-sql/events_sessionization.sql`
- `cdc_mirroring.sql` -> `gitops/charts/beluga-data/files/flink-sql/cdc_mirroring.sql`

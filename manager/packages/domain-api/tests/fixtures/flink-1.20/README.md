# Flink 1.20 REST fixtures

Recorded 2026-10-07 from a live Beluga cluster (Flink 1.20.0, `flink-cluster-rest` service) with
read-only `GET` requests through `kubectl port-forward`. No authentication material is present in the
responses; `/taskmanagers` and `/config` were not kept (they carry pod addresses and are not used).

Real recordings: `overview.json`, `jobs-overview.json`, `job-cdc_orders.json`, `job-cdc_customers.json`,
`job-events_sessionization.json`.

`*.synthetic.json` are hand-edited copies of the recorded cdc_orders / cdc_customers responses with a
changed `state` (RESTARTING, FAILED). They are NOT recordings: a restart/failure cannot be induced on the
live cluster without a mutation.

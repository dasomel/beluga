#!/usr/bin/env python3
"""Build synthetic DuckDB fixtures, prove Gold blocking, and parse Trino offline."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "dbt"
TARGET = PROJECT / "target"
AUDIT_GIT_SHA = "0123456789abcdef0123456789abcdef01234567"
AUDIT_RUN_ID = "ci__dbt_audit_'quoted'"


def require(condition: bool, message: str) -> None:
  if not condition:
    raise ValueError(message)


def read_artifact(directory: Path, name: str) -> dict:
  return json.loads((directory / name).read_text(encoding="utf-8"))


def run(binary: str, command: str, target: str, directory: Path,
        extra: tuple[str, ...] = (), expect_success: bool = True) -> str:
  directory.mkdir(parents=True, exist_ok=True)
  # D-DBT-4: pin local synthetic files regardless of the caller's profile/env.
  # Cost: dedicated output paths; live verification belongs to Phase B instead.
  env = dict(os.environ, DBT_SEND_ANONYMOUS_USAGE_STATS="False",
             DBT_PROFILES_DIR=str(PROJECT), DBT_TARGET=target,
             DBT_CI_PATH=str(directory / "beluga_ci.duckdb"),
             BELUGA_DBT_GIT_SHA=AUDIT_GIT_SHA,
             BELUGA_ORCHESTRATOR_RUN_ID=AUDIT_RUN_ID,
             DBT_ENV_SECRET_TRINO_JWT="offline-parse-only")
  args = [binary, "--no-use-colors", "--no-partial-parse", command,
          "--project-dir", str(PROJECT), "--profiles-dir", str(PROJECT),
          "--target", target]
  if command != "deps":
    args.extend(["--target-path", str(directory)])
  args.extend(extra)
  if command == "show":
    args.append("--quiet")
  if command == "build":
    (directory / "run_results.json").unlink(missing_ok=True)
  if command == "parse":
    (directory / "manifest.json").unlink(missing_ok=True)
  print(f"$ dbt {command} --target {target} {' '.join(extra)}", flush=True)
  result = subprocess.run(args, cwd=PROJECT, env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          timeout=180, check=False)
  (directory / f"{command}.log").write_text(result.stdout, encoding="utf-8")
  print("\n".join(result.stdout.splitlines()[-18:]), flush=True)
  if expect_success:
    require(result.returncode == 0, f"dbt {command} ({target}) exited {result.returncode}; "
            f"see {directory / (command + '.log')}. Install both CI and runtime "
            "hashed requirements (DuckDB and Trino adapters are required).")
  else:
    require(result.returncode == 1,
            f"negative build must fail tests with exit 1, got {result.returncode}")
  return result.stdout


def check_audit(binary: str, directory: Path, previous: tuple[dict, ...] = ()) -> tuple[dict, ...]:
  artifact = read_artifact(directory, "run_results.json")
  manifest = read_artifact(directory, "manifest.json")
  # D-DBT-16: query through dbt's own adapter, avoiding a second Python/driver setup.
  # Cost: one offline show per build; escape hatch: use adapter-specific tooling.
  output = run(binary, "show", "ci", directory,
               ("--inline", "select * from gold_shop.dbt_run_audit",
                "--output", "json", "--limit", "10000"))
  all_rows = json.loads(output)["show"]
  rows = [r for r in all_rows if r["invocation_id"] == artifact["metadata"]["invocation_id"]]
  expected = {r["unique_id"]: r for r in artifact["results"]
              if manifest["nodes"].get(r["unique_id"], {}).get("resource_type")
              in ("model", "test", "seed")}
  require(len(rows) == len(expected) and {r["node_unique_id"] for r in rows} == set(expected),
          "audit must contain exactly one row per build node, including skipped nodes")
  require(len(all_rows) == len(previous) + len(rows) and all(r in all_rows for r in previous),
          "repeat builds must append audit rows and preserve previous invocations unchanged")
  for row in rows:
    result = expected[row["node_unique_id"]]
    node = manifest["nodes"][row["node_unique_id"]]
    require(row["status"] == result["status"], "audit status differs from build result")
    require(row["invocation_id"] == artifact["metadata"]["invocation_id"]
            and row["dbt_version"] == artifact["metadata"]["dbt_version"]
            and bool(row["run_started_at"]), "audit invocation metadata missing or incorrect")
    require(row["target_name"] == "ci" and row["target_engine"] == "duckdb"
            and row["project_git_revision"] == AUDIT_GIT_SHA
            and row["orchestrator_run_id"] == AUDIT_RUN_ID,
            "audit target/git/run-id metadata incorrect (including SQL quote escaping)")
    is_test = node["resource_type"] == "test"
    relation = None if is_test else ".".join((node["database"], node["schema"], node["alias"]))
    require(row["resource_type"] == node["resource_type"] and row["relation"] == relation
            and row["materialization"] == (None if is_test else node["config"]["materialized"]),
            "audit node metadata incorrect")
    affected = result["adapter_response"].get("rows_affected")
    require(row["rows_affected"] == (affected if affected is not None and affected >= 0 else None)
            and row["execution_time"] == result["execution_time"]
            and row["failures"] == (result["failures"] if is_test else None),
            "audit execution metrics incorrect")
    require(row["message"] == (f'status={result["status"]}'
            + (f'; failures={result["failures"]}' if is_test else ""))[:512],
            "audit message must be capped and contain only allowlisted diagnostics")
  require(any(r["resource_type"] == "model" for r in rows)
          and any(r["resource_type"] == "test" for r in rows), "audit omitted models or tests")
  print(f"PASS: audit has {len(rows)} matching node rows with git/run-id metadata", flush=True)
  return tuple(all_rows)


def main() -> int:
  try:
    binary = shutil.which(os.environ.get("DBT_BIN", "dbt"))
    require(binary is not None, "DBT_BIN executable not found (default: dbt)")
    binary = str(Path(binary).resolve())
    TARGET.mkdir(parents=True, exist_ok=True)
    # Clean only this check's synthetic databases, so repeat runs exercise fresh builds.
    for directory in (TARGET, TARGET / "gate-negative", TARGET / "gate-audit-failure"):
      (directory / "beluga_ci.duckdb").unlink(missing_ok=True)
      (directory / "beluga_ci.duckdb.wal").unlink(missing_ok=True)
    run(binary, "deps", "ci", TARGET)
    run(binary, "build", "ci", TARGET, ("--vars", '{"gate_negative": false}'))
    results = read_artifact(TARGET, "run_results.json")["results"]
    require(bool(results) and all(r["status"] in ("success", "pass") for r in results),
            "positive build has missing, skipped, warned, or failed nodes")
    require(any(r["unique_id"] == "test.beluga.ci_daily_revenue" for r in results),
            "expected-value regression test did not execute")
    audit = check_audit(binary, TARGET)
    run(binary, "build", "ci", TARGET, ("--vars", '{"gate_negative": false}'))
    check_audit(binary, TARGET, previous=audit)
    print("PASS: repeat build appended audit rows; prior invocation unchanged", flush=True)

    negative = TARGET / "gate-negative"
    run(binary, "build", "ci", negative, ("--vars", '{"gate_negative": true}'),
        expect_success=False)
    results = read_artifact(negative, "run_results.json")["results"]
    statuses = {r["unique_id"]: r["status"] for r in results}
    failures = [r for r in results if r["status"] == "fail"]
    require(bool(failures) and all("accepted_values_orders_status" in r["unique_id"]
                                 for r in failures),
            "negative fixture must fail the critical accepted_values status test")
    require(not any(r["status"] == "error" for r in results),
            "negative build had an execution error instead of only test failures")
    require(statuses.get("model.beluga.orders") == "success",
            "negative Silver model did not build")
    require(statuses.get("model.beluga.daily_revenue") == "skipped",
            "critical Silver test failure did not skip Gold")
    print("PASS: invalid status failed; model.beluga.daily_revenue=skipped", flush=True)
    check_audit(binary, negative)

    # D-DBT-16: break only a copied audit table to prove hook errors are additive.
    # Cost: one extra failing fixture build; escape hatch: inspect its result artifact.
    audit_failure = TARGET / "gate-audit-failure"
    audit_failure.mkdir(exist_ok=True)
    shutil.copyfile(negative / "beluga_ci.duckdb", audit_failure / "beluga_ci.duckdb")
    run(binary, "run-operation", "ci", audit_failure,
        ("run_query", "--args", json.dumps({"sql":
         "alter table gold_shop.dbt_run_audit rename column status to broken_status"})))
    run(binary, "build", "ci", audit_failure, ("--vars", '{"gate_negative": true}'),
        expect_success=False)
    broken_results = read_artifact(audit_failure, "run_results.json")["results"]
    require(any(r["status"] == "fail" and "accepted_values_orders_status" in r["unique_id"]
                for r in broken_results)
            and any(r["status"] == "error" and r["unique_id"].startswith("operation.")
                    for r in broken_results),
            "audit write error must preserve the original failing test in run_results")
    print("PASS: audit INSERT error preserved original test failure", flush=True)

    parsed = TARGET / "parse-trino"
    run(binary, "parse", "trino", parsed)
    manifest = read_artifact(parsed, "manifest.json")
    for name, schema in (("orders", "silver_shop"), ("daily_revenue", "gold_shop")):
      node = manifest["nodes"][f"model.beluga.{name}"]
      require(node["schema"] == schema and node["database"] == "iceberg",
              f"Trino {name} must resolve to iceberg.{schema}")
    sources = list(manifest["sources"].values())
    require(len(sources) == 1 and sources[0]["schema"] == "lake"
            and sources[0]["identifier"] == "orders"
            and sources[0]["database"] == "iceberg",
            "Trino source must be only iceberg.lake.orders")
    require(not any(n["resource_type"] == "seed" for n in manifest["nodes"].values()),
            "synthetic seeds must be disabled on Trino")
    print("dbt project check PASS: positive build, negative gate, run audit, offline Trino parse")
    return 0
  except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
    print(f"dbt project check FAIL: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
  sys.exit(main())

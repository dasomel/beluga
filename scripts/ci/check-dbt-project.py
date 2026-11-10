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


def require(condition: bool, message: str) -> None:
  if not condition:
    raise ValueError(message)


def read_artifact(directory: Path, name: str) -> dict:
  return json.loads((directory / name).read_text(encoding="utf-8"))


def run(binary: str, command: str, target: str, directory: Path,
        extra: tuple[str, ...] = (), expect_success: bool = True) -> None:
  directory.mkdir(parents=True, exist_ok=True)
  # D-DBT-4: pin local synthetic files regardless of the caller's profile/env.
  # Cost: dedicated output paths; live verification belongs to Phase B instead.
  env = dict(os.environ, DBT_SEND_ANONYMOUS_USAGE_STATS="False",
             DBT_PROFILES_DIR=str(PROJECT), DBT_TARGET=target,
             DBT_CI_PATH=str(directory / "beluga_ci.duckdb"),
             DBT_ENV_SECRET_TRINO_JWT="offline-parse-only")
  args = [binary, "--no-use-colors", "--no-partial-parse", command,
          "--project-dir", str(PROJECT), "--profiles-dir", str(PROJECT),
          "--target", target]
  if command != "deps":
    args.extend(["--target-path", str(directory)])
  args.extend(extra)
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


def main() -> int:
  try:
    binary = shutil.which(os.environ.get("DBT_BIN", "dbt"))
    require(binary is not None, "DBT_BIN executable not found (default: dbt)")
    binary = str(Path(binary).resolve())
    TARGET.mkdir(parents=True, exist_ok=True)
    # Clean only this check's synthetic databases, so repeat runs exercise fresh builds.
    for directory in (TARGET, TARGET / "gate-negative"):
      (directory / "beluga_ci.duckdb").unlink(missing_ok=True)
      (directory / "beluga_ci.duckdb.wal").unlink(missing_ok=True)
    run(binary, "deps", "ci", TARGET)
    run(binary, "build", "ci", TARGET, ("--vars", '{"gate_negative": false}'))
    results = read_artifact(TARGET, "run_results.json")["results"]
    require(bool(results) and all(r["status"] in ("success", "pass") for r in results),
            "positive build has missing, skipped, warned, or failed nodes")
    require(any(r["unique_id"] == "test.beluga.ci_daily_revenue" for r in results),
            "expected-value regression test did not execute")

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
    print("dbt project check PASS: positive build, negative gate, offline Trino parse")
    return 0
  except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
    print(f"dbt project check FAIL: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
  sys.exit(main())

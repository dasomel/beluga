#!/usr/bin/env python3
"""Offline ODCS v3.2.0 profile and events_enriched DDL drift gate (stdlib only)."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT = Path("contracts/lake.events_enriched.json")
DDL = Path("gitops/charts/beluga-data/files/flink-sql/events_sessionization.sql")
TABLE = "lakekeeper.lake.events_enriched"
TYPE_MAP = {"STRING": "string", "BIGINT": "integer", "TIMESTAMP(3)": "timestamp"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text_fields(value, keys, location):
    require(isinstance(value, dict), f"{location}: expected object")
    for key in keys:
        require(isinstance(value.get(key), str) and value[key].strip(),
                f"{location}.{key}: required non-empty string")


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_contract(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)


# D1: JSON avoids another YAML dependency; cost: no YAML input. Extend the
# reader only after dependency review, keeping this offline stdlib gate.
# D2: deliberately parse this product's explicit Flink DDL subset, failing
# closed on new syntax/types. Cost: not a general SQL parser; extend with
# negative fixtures when the canonical DDL changes rather than skipping it.
def ddl_columns(sql):
    sql = re.sub(r"/\*.*?\*/|--[^\n]*", " ", sql, flags=re.S)
    matches = list(re.finditer(
        rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{re.escape(TABLE)}\s*\(",
        sql, re.I))
    require(len(matches) == 1, f"DDL: expected exactly one CREATE TABLE {TABLE}")
    start = matches[0].end()
    depth, current, parts = 1, [], []
    for char in sql[start:]:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if depth == 0:
            parts.append("".join(current).strip())
            break
        if char == "," and depth == 1:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    require(depth == 0, "DDL: unterminated table definition")
    columns = {}
    for part in parts:
        if re.fullmatch(r"PRIMARY\s+KEY\s*\([a-z_,\s]+\)\s+NOT\s+ENFORCED", part, re.I):
            continue
        match = re.fullmatch(r"([a-z_][a-z0-9_]*)\s+([a-z]+(?:\s*\(\s*\d+\s*\))?)", part, re.I)
        require(match is not None, f"DDL: unsupported column/constraint: {part}")
        name, physical = match.groups()
        physical = re.sub(r"\s+", "", physical).upper()
        require(physical in TYPE_MAP, f"DDL: unsupported type {physical}")
        require(name not in columns, f"DDL: duplicate column {name}")
        columns[name] = physical
    require(columns, "DDL: no columns")
    return columns


def validate(contract, sql):
    text_fields(contract, ("apiVersion", "kind", "id", "version", "status", "name", "domain"), "contract")
    require(contract["apiVersion"] == "v3.2.0", "contract.apiVersion: expected v3.2.0")
    require(contract["kind"] == "DataContract", "contract.kind: expected DataContract")
    require(re.fullmatch(r"\d+\.\d+\.\d+", contract["version"]), "contract.version: expected major.minor.patch")
    require(contract["status"] in {"proposed", "draft", "active", "deprecated", "retired"}, "contract.status: unsupported lifecycle status")
    text_fields(contract.get("description"), ("purpose", "usage", "limitations"), "description")
    team = contract.get("team")
    require(isinstance(team, dict) and isinstance(team.get("members"), list) and team["members"], "team.members: required non-empty array")
    for member in team["members"]:
        text_fields(member, ("username", "role"), "team member")
    require(any(m["role"] == "owner" for m in team["members"]), "team.members: owner required")
    schema = contract.get("schema")
    require(isinstance(schema, list) and len(schema) == 1, "schema: expected one product object")
    obj = schema[0]
    text_fields(obj, ("name", "physicalName", "logicalType", "description"), "schema object")
    require(obj["name"] == "events_enriched" and obj["physicalName"] == "lake.events_enriched" and obj["logicalType"] == "object", "schema: unexpected product identity")
    properties = obj.get("properties")
    require(isinstance(properties, list) and properties, "schema.properties: required non-empty array")
    actual = {}
    for prop in properties:
        text_fields(prop, ("name", "physicalType", "logicalType", "description", "classification"), "property")
        name, physical = prop["name"], prop["physicalType"]
        require(name not in actual, f"schema: duplicate column {name}")
        require(physical in TYPE_MAP and prop["logicalType"] == TYPE_MAP[physical], f"schema: inconsistent types for {name}")
        actual[name] = physical
    expected = ddl_columns(sql)
    require(actual == expected, f"schema drift: DDL={expected}; contract={actual}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=REPO_ROOT / CONTRACT)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = subprocess.run([sys.executable, str(REPO_ROOT / "tests/test_data_contracts.py")], check=False)
        if result.returncode:
            return result.returncode
    try:
        validate(load_contract(args.contract), (args.root / DDL).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"FAIL data contracts: {exc}", file=sys.stderr)
        return 1
    print("PASS data contracts: ODCS v3.2.0 profile; lake.events_enriched columns/types match DDL")
    return 0


if __name__ == "__main__":
    sys.exit(main())

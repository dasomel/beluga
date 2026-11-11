#!/usr/bin/env python3
"""Offline shop CDC manifest preflight (stdlib only; Issue #71)."""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path("sources/shop/shop-cdc.json")
CONNECTOR = Path("gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml")
SCHEMA = Path("gitops/charts/beluga-data/files/shop-schema.sql")
CLASSES = {"internal", "pii"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def text(value):
    return isinstance(value, str) and bool(value.strip())


def schema_tables(sql):
    # D1: parse only the checked-in simple inline-PK DDL, avoiding a new SQL
    # dependency. Cost: no general PostgreSQL grammar; extend this fail-closed
    # adapter and fixtures explicitly when the source DDL needs richer forms.
    sql = re.sub(r"--[^\n]*", "", sql)
    headers = re.findall(r"\bCREATE\s+TABLE\b", sql, re.I)
    matches = list(re.finditer(
        r"CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)\s*\((.*?)^\);",
        sql, re.M | re.S,
    ))
    require(matches and len(headers) == len(matches), "unsupported or missing shop DDL")
    result = {}
    for match in matches:
        table, body = match.groups()
        parts, start, depth = [], 0, 0
        for index, char in enumerate(body):
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif char == "," and depth == 0:
                parts.append(body[start:index].strip())
                start = index + 1
            require(depth >= 0, f"invalid DDL parentheses: {table}")
        parts.append(body[start:].strip())
        require(depth == 0, f"invalid DDL parentheses: {table}")
        columns, keys = set(), []
        for part in parts:
            column = re.fullmatch(r"([a-z_][a-z0-9_]*)\s+(.+)", part, re.S)
            require(column is not None, f"unsupported column DDL: {table}")
            name, definition = column.groups()
            require(name.upper() not in {"PRIMARY", "CONSTRAINT", "FOREIGN", "UNIQUE", "CHECK"},
                    f"unsupported table constraint: {table}")
            require(name not in columns, f"duplicate DDL column: {table}.{name}")
            columns.add(name)
            if re.search(r"\bPRIMARY\s+KEY\b", definition, re.I):
                keys.append(name)
        require(len(keys) == 1, f"expected one inline primary key: {table}")
        require(f"public.{table}" not in result, f"duplicate DDL table: {table}")
        result[f"public.{table}"] = (columns, keys)
    return result


def validate(root, manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"),
                          object_pairs_hook=unique_object)
    require(isinstance(manifest, dict), "manifest must be an object")
    # D3: allowlist the scoped declaration to reject secret literals and typos.
    # Cost: extensions fail until reviewed here; add fields with validation and
    # fixtures when the registration contract grows.
    require(set(manifest) <= {"apiVersion", "kind", "name", "owner", "sourceClass",
                             "ingestionMode", "sourceSystem", "database", "topicPrefix",
                             "classification", "freshness", "retention", "tables"},
            "unsupported manifest fields (credentials must remain in Secrets)")
    for key in ("name", "owner", "sourceSystem", "database", "topicPrefix"):
        require(text(manifest.get(key)), f"missing/non-string {key}")
    for key, expected in (("apiVersion", "beluga.data/v1alpha1"),
                          ("kind", "SourceRegistration"),
                          ("sourceClass", "relational-cdc"),
                          ("ingestionMode", "continuous-cdc")):
        require(manifest.get(key) == expected, f"invalid {key}: expected {expected}")
    for key in ("freshness", "retention"):
        value = manifest.get(key)
        require(text(value) and re.fullmatch(r"P(?:[1-9][0-9]*D|T[1-9][0-9]*[HMS])", value),
                f"{key} must be a positive duration (PnD or PTnH/M/S)")

    template = (root / CONNECTOR).read_text(encoding="utf-8")
    # D2: read the actual literal registration body, not a copied config or Helm
    # render. Cost: this adapter is coupled to the heredoc; fail on refactoring
    # and replace it with an explicit adapter rather than silently skipping it.
    bodies = re.findall(r"BODY=\$\(cat <<'EOF'\n(.*?)\n\s*EOF\n", template, re.S)
    require(len(bodies) == 1, "expected exactly one connector config heredoc")
    config = json.loads(bodies[0], object_pairs_hook=unique_object)
    require(isinstance(config, dict), "connector config must be an object")
    names = re.findall(r"\$\{CONNECT\}/connectors/([^/\s\"]+)/config", template)
    require(names == [manifest["name"]], "connector name mismatch")
    require(config.get("connector.class") == "io.debezium.connector.postgresql.PostgresConnector",
            "expected PostgreSQL Debezium connector")
    for field, key in (("database.dbname", "database"), ("topic.prefix", "topicPrefix")):
        require(config.get(field) == manifest[key], f"{field} mismatch or missing")
    require("message.key.columns" not in config and not any(
        key == "transforms" or key.startswith("transforms.") for key in config),
        "key overrides/transforms unsupported: default PostgreSQL primary keys required")
    include = config.get("table.include.list")
    require(text(include), "missing table.include.list")
    tables = [name.strip() for name in include.split(",")]
    require(len(set(tables)) == len(tables), "duplicate connector table")
    declared = manifest.get("tables")
    require(isinstance(declared, dict) and declared, "missing/non-object tables")
    require(set(tables) == set(declared), "table.include.list mismatch")
    # D-WAL-5: fail closed on idle-database WAL retention, including pgoutput's
    # filtered publication. Cost: shop-specific UPSERT contract; extend this
    # adapter and negative fixtures together for another heartbeat strategy.
    interval = config.get("heartbeat.interval.ms")
    require(isinstance(interval, str) and interval.isdecimal()
            and 0 < int(interval) <= 60000,
            "heartbeat.interval.ms must be positive and <=60000")
    require(config.get("heartbeat.action.query") == (
        "INSERT INTO public.cdc_heartbeat (id, updated_at) VALUES (1, NOW()) "
        "ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at"),
        "heartbeat.action.query must UPSERT the singleton heartbeat table")
    require("public.cdc_heartbeat" in tables, "heartbeat table must be captured")
    require(config.get("plugin.name") == "pgoutput"
            and config.get("publication.autocreate.mode") == "filtered"
            and config.get("publication.name") == "dbz_publication",
            "heartbeat requires pgoutput filtered dbz_publication")
    require(config.get("topic.heartbeat.prefix") == "__debezium-heartbeat",
            "heartbeat topic prefix must match the GitOps KafkaTopic")
    actual = schema_tables((root / SCHEMA).read_text(encoding="utf-8"))
    source_class = manifest.get("classification")
    require(isinstance(source_class, str) and source_class in CLASSES,
            "missing/invalid source classification")
    for name, table in declared.items():
        require(name in actual, f"table not found in shop DDL: {name}")
        require(isinstance(table, dict), f"{name}: table must be an object")
        require(set(table) <= {"keyFields", "classification", "columns"},
                f"{name}: unsupported table fields")
        columns, keys = actual[name]
        require(table.get("keyFields") == keys, f"{name}: keyFields mismatch or missing")
        classification = table.get("classification")
        require(isinstance(classification, str) and classification in CLASSES,
                f"{name}: missing/invalid classification")
        declared_columns = table.get("columns")
        require(isinstance(declared_columns, dict) and set(declared_columns) == columns,
                f"{name}: column classification coverage mismatch")
        require(all(isinstance(value, str) and value in CLASSES
                    for value in declared_columns.values()),
                f"{name}: invalid column classification")
        require("pii" not in declared_columns.values() or classification == "pii",
                f"{name}: table classification must cover pii columns")
        require(classification != "pii" or source_class == "pii",
                "source classification must cover pii tables")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    try:
        validate(args.root, args.root / args.manifest)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"FAIL source onboarding: {exc}", file=sys.stderr)
        return 1
    print("PASS shop-cdc source manifest matches connector and DDL (static only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

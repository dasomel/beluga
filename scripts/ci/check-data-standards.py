#!/usr/bin/env python3
"""Check representative database schemas against policies/data-standards.yaml."""

import argparse
import fnmatch
import re
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: install requirements-ci.txt with --require-hashes for PyYAML", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY = REPO_ROOT / "policies/data-standards.yaml"
SQL_IDENTIFIER = r'(?:`[^`]+`|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)'
CREATE_TABLE_RE = re.compile(
    rf"^\s*CREATE\s+(?:(?P<temporary>TEMPORARY|TEMP)\s+)?TABLE\s+"
    rf"(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>{SQL_IDENTIFIER}(?:\s*\.\s*{SQL_IDENTIFIER})*)\s*(?P<body>.*)$",
    re.IGNORECASE | re.DOTALL,
)
DOLLAR_QUOTE_RE = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*\$|\$)")
# D1: selected durable DDL is the representative boundary.  This omits
# connector wire schemas (cost: no transport-schema governance); extend
# schema_sources deliberately when those schemas become canonical datasets.
# D2: metadata is a Git policy registry rather than SQL COMMENT statements.
# Cost: it is not runtime catalog state; replace the registry adapter when a
# governed catalog becomes authoritative without weakening this static gate.


def load_policy(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ValueError(f"cannot load data standards policy {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("policy must be a mapping")
    for key in ("schema_sources", "tables", "baselines"):
        if not isinstance(data.get(key), list):
            raise ValueError(f"policy {key} must be a list")
    naming, metadata = data.get("naming"), data.get("metadata")
    if not isinstance(naming, dict) or not isinstance(metadata, dict):
        raise ValueError("policy requires naming and metadata mappings")
    try:
        re.compile(naming["identifier_pattern"])
    except (KeyError, TypeError, re.error) as exc:
        raise ValueError("naming.identifier_pattern must be a valid regex") from exc
    for key in ("table_required", "column_required", "classifications"):
        if not isinstance(metadata.get(key), list) or not metadata[key]:
            raise ValueError(f"metadata.{key} must be a non-empty list")
    threshold = metadata.get("completeness_threshold_percent")
    if not isinstance(threshold, int) or not 0 <= threshold <= 100:
        raise ValueError("metadata.completeness_threshold_percent must be an integer from 0 through 100")
    if any(not isinstance(item, str) or not item.strip() for item in metadata["classifications"]):
        raise ValueError("metadata.classifications must contain non-empty strings")
    try:
        re.compile(metadata["duration_pattern"])
    except (KeyError, TypeError, re.error) as exc:
        raise ValueError("metadata.duration_pattern must be a valid regex") from exc
    return data


def normalize_identifier(value: str) -> str:
    return ".".join(part.strip().strip('`\"') for part in re.split(r"\s*\.\s*", value))


def dollar_quote_at(sql: str, index: int) -> str | None:
    """Return a PostgreSQL dollar-quote delimiter beginning at index, if any."""
    if sql[index] != "$" or (index and (sql[index - 1].isalnum() or sql[index - 1] == "_")):
        return None
    match = DOLLAR_QUOTE_RE.match(sql, index)
    return match.group(0) if match else None


def strip_sql_comments(sql: str, path: Path) -> str:
    """Replace SQL comments with whitespace while preserving quoted literals."""
    result, index, quote = [], 0, None
    while index < len(sql):
        char = sql[index]
        if quote:
            if len(quote) > 1:
                if sql.startswith(quote, index):
                    result.extend(quote)
                    index += len(quote)
                    quote = None
                    continue
                result.append(char)
                index += 1
                continue
            result.append(char)
            if char == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    result.append(sql[index + 1])
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        dollar_quote = dollar_quote_at(sql, index)
        if dollar_quote:
            quote = dollar_quote
            result.extend(dollar_quote)
            index += len(dollar_quote)
            continue
        if char in "'`\"":
            quote = char
            result.append(char)
            index += 1
            continue
        if sql.startswith("--", index):
            while index < len(sql) and sql[index] not in "\r\n":
                result.append(" ")
                index += 1
            continue
        if sql.startswith("/*", index):
            result.extend("  ")
            index += 2
            while index < len(sql) and not sql.startswith("*/", index):
                result.append("\n" if sql[index] == "\n" else " ")
                index += 1
            if index == len(sql):
                raise ValueError(f"{path}: unsupported DDL form: unterminated block comment")
            result.extend("  ")
            index += 2
            continue
        result.append(char)
        index += 1
    return "".join(result)


def split_sql_statements(sql: str) -> list[str]:
    """Split semicolon-terminated SQL while preserving semicolons in literals."""
    statements, current, quote = [], [], None
    index = 0
    while index < len(sql):
        if quote and len(quote) > 1:
            if sql.startswith(quote, index):
                current.extend(quote)
                index += len(quote)
                quote = None
                continue
            current.append(sql[index])
            index += 1
            continue
        if not quote:
            dollar_quote = dollar_quote_at(sql, index)
            if dollar_quote:
                current.extend(dollar_quote)
                index += len(dollar_quote)
                quote = dollar_quote
                continue
        char = sql[index]
        current.append(char)
        if quote:
            if char == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    current.append(sql[index + 1])
                    index += 2
                    continue
                quote = None
        elif char in "'`\"":
            quote = char
        elif char == ";":
            statements.append("".join(current[:-1]))
            current = []
        index += 1
    if "".join(current).strip():
        statements.append("".join(current))
    return statements


def split_definitions(body: str) -> list[str]:
    parts, current, depth, quote = [], [], 0, None
    index = 0
    while index < len(body):
        if quote and len(quote) > 1:
            if body.startswith(quote, index):
                current.extend(quote)
                index += len(quote)
                quote = None
                continue
            current.append(body[index])
            index += 1
            continue
        if not quote:
            dollar_quote = dollar_quote_at(body, index)
            if dollar_quote:
                current.extend(dollar_quote)
                index += len(dollar_quote)
                quote = dollar_quote
                continue
        char = body[index]
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "'`\"":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    if "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


def table_body(sql: str, open_paren: int) -> tuple[str, int]:
    depth, quote = 0, None
    index = open_paren
    while index < len(sql):
        if quote and len(quote) > 1:
            if sql.startswith(quote, index):
                index += len(quote)
                quote = None
                continue
            index += 1
            continue
        if not quote:
            dollar_quote = dollar_quote_at(sql, index)
            if dollar_quote:
                quote = dollar_quote
                index += len(dollar_quote)
                continue
        char = sql[index]
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "'`\"":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return sql[open_paren + 1:index], index
        index += 1
    raise ValueError("unterminated CREATE TABLE definition")


def parse_table_statement(statement: str, path: Path) -> tuple[str, dict[str, str], str | None] | None:
    """Parse one CREATE TABLE statement, failing closed for unsupported forms."""
    match = CREATE_TABLE_RE.match(statement)
    if not match:
        if re.match(r"^\s*CREATE\b", statement, re.I) and re.search(r"\bTABLE\b", statement, re.I):
            raise ValueError(f"{path}: unsupported DDL form: cannot parse CREATE TABLE statement")
        return None
    if match.group("temporary"):
        return None

    object_name = normalize_identifier(match.group("name"))
    body = match.group("body").lstrip()
    if body.startswith("("):
        try:
            definition_body, close_paren = table_body(body, 0)
        except ValueError as exc:
            raise ValueError(f"{path}: unsupported DDL form for {object_name}: {exc}") from exc
        suffix = body[close_paren + 1:].strip()
        if suffix and not re.match(r"^WITH\s*\(", suffix, re.I):
            return object_name, {}, "unsupported DDL form: column-list table has unsupported trailing clause"
        columns = {}
        for definition in split_definitions(definition_body):
            if not definition or re.match(r"^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|WATERMARK|CHECK)\b", definition, re.I):
                continue
            column_match = re.match(r"\s*([`\"A-Za-z_][`\"A-Za-z0-9_]*)\s+(.+)$", definition, re.S)
            if not column_match:
                return object_name, {}, "unsupported DDL form: cannot parse column definition"
            name = normalize_identifier(column_match.group(1))
            columns[name] = re.sub(r"\s+", " ", column_match.group(2)).upper()
        return object_name, columns, None
    if re.match(r"^AS\s+(?:SELECT|WITH)\b", body, re.I):
        return object_name, {}, "unsupported DDL form: CTAS has no declared column definitions"
    if re.match(r"^LIKE\b", body, re.I):
        return object_name, {}, "unsupported DDL form: LIKE has no declared column definitions"
    return object_name, {}, "unsupported DDL form: expected a column list, AS SELECT, or LIKE"


def parse_tables(path: Path) -> dict[str, tuple[dict[str, str], str | None]]:
    sql = strip_sql_comments(path.read_text(encoding="utf-8"), path)
    tables = {}
    for statement in split_sql_statements(sql):
        parsed = parse_table_statement(statement, path)
        if parsed is not None:
            object_name, columns, unsupported = parsed
            tables[object_name] = columns, unsupported
    return tables


def metadata_score(table: dict, table_required: list[str], column_required: list[str], actual_columns: list[str]) -> tuple[int, int, float, list[str]]:
    missing = []
    table_metadata = table.get("metadata") if isinstance(table.get("metadata"), dict) else {}
    for field in table_required:
        if not isinstance(table_metadata.get(field), str) or not table_metadata[field].strip():
            missing.append(f"table.{field}")
    columns = table.get("columns") if isinstance(table.get("columns"), dict) else {}
    for name in actual_columns:
        column = columns.get(name)
        values = column if isinstance(column, dict) else {}
        for field in column_required:
            if not isinstance(values.get(field), str) or not values[field].strip():
                missing.append(f"column.{name}.{field}")
    total = len(table_required) + len(column_required) * len(actual_columns)
    present = total - len(missing)
    return present, total, (100 * present / total if total else 0), missing


def matching_objects(root: Path, sources: list[dict]) -> dict[tuple[str, str], tuple[dict[str, str], str | None]]:
    found = {}
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("path"), str):
            raise ValueError("each schema_sources item requires path")
        patterns = source.get("include_ddl")
        if not isinstance(patterns, list) or not patterns or not all(isinstance(item, str) for item in patterns):
            raise ValueError(f"schema source {source['path']} requires non-empty include_ddl")
        path = root / source["path"]
        if not path.is_file():
            raise ValueError(f"schema source does not exist: {source['path']}")
        for object_name, table in parse_tables(path).items():
            if any(fnmatch.fnmatchcase(object_name.lower(), pattern.lower()) for pattern in patterns):
                found[(source["path"], object_name)] = table
    return found


def validate(root: Path, policy: dict) -> tuple[list[str], list[str]]:
    errors, scores = [], []
    metadata, naming = policy["metadata"], policy["naming"]
    objects = matching_objects(root, policy["schema_sources"])
    declared = {}
    ids = set()
    violations = set()

    # D3: compare discovered DDL to registry entries both ways so a new durable
    # table cannot be added under a selected source without governance metadata.
    # Cost: source selectors need maintenance; the escape hatch is an explicit
    # schema_sources selector change, reviewed with the new dataset's metadata.
    for table in policy["tables"]:
        if not isinstance(table, dict):
            errors.append("policy tables items must be mappings")
            continue
        table_id, source, ddl_object = table.get("id"), table.get("source"), table.get("ddl_object")
        if not all(isinstance(value, str) and value for value in (table_id, source, ddl_object)):
            errors.append("policy table requires non-empty id, source, and ddl_object")
            continue
        if table_id in ids:
            errors.append(f"duplicate table id: {table_id}")
            continue
        ids.add(table_id)
        key = (source, normalize_identifier(ddl_object))
        if key in declared:
            errors.append(f"duplicate DDL declaration: {source}:{ddl_object}")
            continue
        declared[key] = table

    for key in sorted(objects):
        if key not in declared:
            errors.append(f"unregistered representative DDL: {key[0]}:{key[1]}")
        _, unsupported = objects[key]
        if unsupported:
            errors.append(f"{key[0]}:{key[1]}: {unsupported}")
    for key, table in declared.items():
        if key not in objects:
            errors.append(f"stale registry DDL entry: {table['id']} -> {key[0]}:{key[1]}")
            continue
        columns, unsupported = objects[key]
        if unsupported:
            continue
        pattern = re.compile(naming["identifier_pattern"])
        for identifier in key[1].split(".") + list(columns):
            if not pattern.fullmatch(identifier):
                violations.add(f"{table['id']}:identifier:{identifier}:snake_case")
        registered_columns = table.get("columns") if isinstance(table.get("columns"), dict) else {}
        table_metadata = table.get("metadata") if isinstance(table.get("metadata"), dict) else {}
        allowed_classifications = set(metadata["classifications"])
        if table_metadata.get("classification") not in allowed_classifications:
            errors.append(f"{table['id']} has invalid table classification: {table_metadata.get('classification')!r}")
        duration_pattern = re.compile(metadata["duration_pattern"])
        for field in ("retention", "freshness"):
            value = table_metadata.get(field)
            if isinstance(value, str) and value and not duration_pattern.fullmatch(value):
                errors.append(f"{table['id']} {field} is not an ISO-8601 duration: {value!r}")
        for name in sorted(columns):
            if name not in registered_columns:
                errors.append(f"{table['id']} missing column metadata registry entry: {name}")
        for name in sorted(registered_columns):
            if name not in columns:
                errors.append(f"{table['id']} stale column metadata registry entry: {name}")
            elif not isinstance(registered_columns[name], dict) or registered_columns[name].get("classification") not in allowed_classifications:
                errors.append(f"{table['id']}.{name} has invalid column classification")
        for name, type_expression in columns.items():
            if name in naming.get("reserved_identifiers", []):
                violations.add(f"{table['id']}:column:{name}:reserved_identifier")
            for suffix, allowed_types in naming.get("suffix_types", {}).items():
                if name.endswith(suffix) and not any(type_expression.startswith(value.upper()) for value in allowed_types):
                    violations.add(f"{table['id']}:column:{name}:{suffix}_type")
        present, total, percent, missing = metadata_score(table, metadata["table_required"], metadata["column_required"], list(columns))
        scores.append(f"METADATA {table['id']}: {present}/{total} ({percent:.1f}%)")
        if missing:
            errors.append(f"{table['id']} metadata missing: {', '.join(missing)}")
        if percent < metadata["completeness_threshold_percent"]:
            errors.append(f"{table['id']} metadata completeness {percent:.1f}% is below {metadata['completeness_threshold_percent']}%")

    baseline_ids = set()
    for item in policy["baselines"]:
        if not isinstance(item, dict) or not all(isinstance(item.get(field), str) and item[field].strip() for field in ("id", "reason")) or not isinstance(item.get("issue"), int):
            errors.append("baseline requires non-empty id/reason and integer issue")
            continue
        if item["id"] in baseline_ids:
            errors.append(f"duplicate baseline: {item['id']}")
        baseline_ids.add(item["id"])
    for baseline_id in sorted(baseline_ids - violations):
        errors.append(f"stale baseline entry no longer matches a violation: {baseline_id}")
    for violation in sorted(violations - baseline_ids):
        errors.append(f"standards violation: {violation}")
    return errors, scores


def fixture_errors(kind: str) -> list[str]:
    """Return diagnostics for an isolated synthetic fixture used by self-tests."""
    policy = {
        "schema_sources": [{"path": "schema.sql", "include_ddl": ["*"]}],
        "naming": {"identifier_pattern": "^[a-z][a-z0-9_]*$", "reserved_identifiers": [], "suffix_types": {"_at": ["timestamp"]}},
        "metadata": {"table_required": ["owner", "classification", "description", "retention", "freshness"], "column_required": ["description"], "classifications": ["internal"], "duration_pattern": "^P(?=\\d|T\\d)(?:\\d+[YMWD])*(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?$", "completeness_threshold_percent": 100},
        "tables": [{"id": "test.good_table", "source": "schema.sql", "ddl_object": "good_table", "metadata": {"owner": "team", "classification": "internal", "description": "Good.", "retention": "P7D", "freshness": "PT5M"}, "columns": {"record_id": {"description": "ID.", "classification": "internal"}, "created_at": {"description": "When.", "classification": "internal"}}}],
        "baselines": [],
    }
    with tempfile.TemporaryDirectory(prefix="beluga-data-standards-") as tmp:
        root = Path(tmp)
        (root / "schema.sql").write_text("CREATE TABLE good_table (record_id INT, created_at TIMESTAMP, CHECK (record_id > 0));", encoding="utf-8")
        if kind == "conforming":
            pass
        elif kind == "bad-name":
            policy["tables"][0]["ddl_object"] = "BadTable"
            (root / "schema.sql").write_text("CREATE TABLE BadTable (record_id INT, created_at TIMESTAMP);", encoding="utf-8")
        elif kind == "missing-metadata":
            policy["metadata"]["completeness_threshold_percent"] = 0
            policy["tables"][0]["metadata"].pop("description")
        elif kind == "low-completeness":
            policy["tables"][0]["metadata"].pop("description")
        elif kind == "stale-baseline":
            policy["baselines"] = [{"id": "test.good_table:column:gone:reserved_identifier", "reason": "fixture", "issue": 33}]
        elif kind == "bad-duration":
            policy["tables"][0]["metadata"]["retention"] = "forever"
        elif kind == "unregistered-column-list":
            (root / "schema.sql").write_text(
                "CREATE TABLE good_table (record_id INT, created_at TIMESTAMP); "
                "CREATE TABLE unregistered_table (record_id INT);",
                encoding="utf-8",
            )
        elif kind == "unregistered-ctas":
            (root / "schema.sql").write_text(
                "CREATE TABLE good_table (record_id INT, created_at TIMESTAMP); "
                "CREATE TABLE unregistered_ctas AS SELECT record_id, created_at FROM good_table;",
                encoding="utf-8",
            )
        elif kind == "stale-registry":
            policy["tables"].append({
                "id": "test.stale_table",
                "source": "schema.sql",
                "ddl_object": "stale_table",
                "metadata": {"owner": "team", "classification": "internal", "description": "Stale.", "retention": "P7D", "freshness": "PT5M"},
                "columns": {},
            })
        elif kind == "commented-out-ddl":
            (root / "schema.sql").write_text(
                "-- CREATE TABLE old_customers_draft (\n"
                "--   legacy_id INT\n"
                "-- );\n"
                "/* CREATE TABLE old_orders_draft (legacy_id INT); */\n"
                "CREATE TABLE good_table (record_id INT, created_at TIMESTAMP);",
                encoding="utf-8",
            )
        elif kind == "dollar-quoted-literal":
            (root / "schema.sql").write_text(
                "CREATE TABLE good_table (record_id INT DEFAULT $$a,b -- /* literal */$$, created_at TIMESTAMP);",
                encoding="utf-8",
            )
        elif kind == "unsupported-ddl":
            (root / "schema.sql").write_text(
                "CREATE TABLE good_table (record_id INT, created_at TIMESTAMP); "
                "CREATE TABLE unsupported_table CLONE good_table;",
                encoding="utf-8",
            )
        else:
            raise ValueError(f"unknown fixture: {kind}")
        return validate(root, policy)[0]


def self_test() -> None:
    """Run conforming and required negative fixtures on every invocation."""
    expectations = {
        "conforming": None,
        "bad-name": "snake_case",
        "missing-metadata": "metadata missing",
        "low-completeness": "below 100%",
        "stale-baseline": "stale baseline",
        "bad-duration": "not an ISO-8601 duration",
        "unregistered-column-list": "unregistered representative DDL",
        "unregistered-ctas": "unregistered representative DDL",
        "stale-registry": "stale registry DDL entry",
        "commented-out-ddl": None,
        "dollar-quoted-literal": None,
        "unsupported-ddl": "unsupported DDL form",
    }
    for kind, expected in expectations.items():
        errors = fixture_errors(kind)
        if expected is None and errors:
            raise ValueError(f"self-test rejected conforming fixture: {errors}")
        if expected is not None and not any(expected in error for error in errors):
            raise ValueError(f"self-test accepted {kind} fixture")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY, help="data standards policy path")
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="repository root for schema paths")
    parser.add_argument(
        "--fixture",
        choices=["bad-name", "missing-metadata", "low-completeness", "stale-baseline", "bad-duration", "unregistered-column-list", "unregistered-ctas", "stale-registry", "commented-out-ddl", "dollar-quoted-literal", "unsupported-ddl"],
        help="run one synthetic fixture",
    )
    args = parser.parse_args()
    try:
        self_test()
        if args.fixture:
            errors = fixture_errors(args.fixture)
            print("=== Data standards synthetic fixture ===")
            print("\n".join(f"FAIL: {error}" for error in errors))
            return 1 if errors else 0
        errors, scores = validate(args.root.resolve(), load_policy(args.policy.resolve()))
    except (OSError, ValueError) as exc:
        print(f"data standards check FAIL: {exc}", file=sys.stderr)
        return 1
    print("=== Data standards check ===")
    print("\n".join(scores))
    if errors:
        print("\n".join(f"FAIL: {error}" for error in errors))
        return 1
    print(f"PASS: {len(scores)} representative tables conform; metadata completeness meets policy threshold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

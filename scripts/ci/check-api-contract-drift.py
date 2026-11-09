#!/usr/bin/env python3
"""Compare response contracts in a bounded OpenAPI JSON profile (Issue #78)."""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "contracts/apis/mock-rest"
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
ANNOTATIONS = {"title", "description", "example", "examples", "deprecated", "default"}
SCHEMA_KEYS = ANNOTATIONS | {"type", "properties", "required", "items", "nullable"}
TYPES = {"object", "array", "string", "integer", "number", "boolean", "null"}


def mapping(value, where):
    if not isinstance(value, dict):
        raise ValueError(f"{where}: expected object")
    return value


def nonempty_string(value, where):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{where}: expected non-empty string")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load(path):
    return mapping(json.loads(path.read_text(encoding="utf-8"),
                              object_pairs_hook=unique_object), str(path))


def schema(value, doc, where, version, stack=()):
    value = mapping(value, where)
    if "$ref" in value:
        ref = value["$ref"]
        # D1: local schema refs only; no network/file reads or recursive expansion.
        # Cost: recursive/external contracts need a reviewed adapter; extend here later.
        if (not isinstance(ref, str) or not ref.startswith("#/components/schemas/")
                or set(value) != {"$ref"} or ref in stack):
            raise ValueError(f"{where}: unsupported/cyclic schema reference {ref!r}")
        target = doc
        try:
            for token in ref[2:].split("/"):
                target = target[token.replace("~1", "/").replace("~0", "~")]
        except (KeyError, TypeError) as exc:
            raise ValueError(f"{where}: unresolved reference {ref}") from exc
        return schema(target, doc, where, version, (*stack, ref))
    unknown = set(value) - SCHEMA_KEYS
    if unknown:
        raise ValueError(f"{where}: unsupported schema keywords: {', '.join(sorted(unknown))}")
    kind = value.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    if (not kinds or any(not isinstance(k, str) or k not in TYPES for k in kinds)
            or len(set(kinds)) != len(kinds)):
        raise ValueError(f"{where}: explicit valid type required")
    if version.startswith("3.0.") and (isinstance(kind, list) or "null" in kinds):
        raise ValueError(f"{where}: OpenAPI 3.0 requires nullable rather than null types")
    if "nullable" in value:
        if not version.startswith("3.0.") or not isinstance(value["nullable"], bool):
            raise ValueError(f"{where}: nullable is a boolean for OpenAPI 3.0 only")
        if value["nullable"]:
            kinds = [*kinds, "null"]
    props = mapping(value.get("properties", {}), where + "/properties")
    required = value.get("required", [])
    if (not isinstance(required, list) or any(not isinstance(k, str) for k in required)
            or len(set(required)) != len(required) or set(required) - set(props)):
        raise ValueError(f"{where}: required must name distinct declared properties")
    if (props or "required" in value or "properties" in value) and "object" not in kinds:
        raise ValueError(f"{where}: properties/required require object type")
    result = {"type": sorted(kinds), "required": sorted(required), "properties": {}}
    for name, child in sorted(props.items()):
        result["properties"][name] = schema(child, doc, f"{where}/properties/{name}", version, stack)
    if "array" in kinds:
        if "items" not in value:
            raise ValueError(f"{where}: array requires items")
        result["items"] = schema(value["items"], doc, where + "/items", version, stack)
    elif "items" in value:
        raise ValueError(f"{where}: items requires array type")
    return result


def inventory(doc):
    version = doc.get("openapi")
    if not isinstance(version, str) or not re.fullmatch(r"3\.[01]\.\d+", version):
        raise ValueError("openapi: supported versions are 3.0.x and 3.1.x")
    info = mapping(doc.get("info"), "info")
    for key in ("title", "version"):
        nonempty_string(info.get(key), "info/" + key)
    paths = mapping(doc.get("paths"), "paths")
    result, ids = {}, set()
    for path, item in sorted(paths.items()):
        if not path.startswith("/"):
            raise ValueError(f"paths/{path}: path must start with /")
        item = mapping(item, path)
        if "$ref" in item:
            raise ValueError(f"{path}: path references unsupported")
        for method in sorted(METHODS & set(item)):
            where = f"{method.upper()} {path}"
            operation = mapping(item[method], where)
            op_id = nonempty_string(operation.get("operationId"), where + "/operationId")
            if op_id in ids:
                raise ValueError(f"{where}: duplicate operationId {op_id}")
            ids.add(op_id)
            responses = mapping(operation.get("responses"), where + "/responses")
            if not responses:
                raise ValueError(f"{where}: responses must not be empty")
            entry = {"operationId": op_id, "responses": {}}
            for status, response in sorted(responses.items()):
                if not re.fullmatch(r"[1-5](?:\d{2}|XX)|default", status):
                    raise ValueError(f"{where}: invalid response status {status}")
                loc = f"{where}/responses/{status}"
                response = mapping(response, loc)
                if "$ref" in response:
                    raise ValueError(f"{loc}: response references unsupported")
                nonempty_string(response.get("description"), loc + "/description")
                content = mapping(response.get("content", {}), loc + "/content")
                media = {}
                for mime, body in sorted(content.items()):
                    body = mapping(body, loc + "/" + mime)
                    media[mime] = schema(body.get("schema"), doc, loc + "/" + mime, version)
                entry["responses"][status] = media
            result[where] = entry
    if not result:
        raise ValueError("paths: at least one operation required")
    return result


def compare_schema(old, new, where, changes):
    def add(level, detail):
        changes.append((level, where, detail))

    if old["type"] != new["type"]:
        add("BREAKING", f"type changed {old['type']} -> {new['type']}")
    a, b = old["properties"], new["properties"]
    for name in sorted(a.keys() - b.keys()):
        changes.append(("BREAKING", where + "/properties/" + name, "field removed"))
    # D2: response-consumer policy: added fields are additive, lost guarantees break.
    # Cost: request compatibility is not checked; add a separate directional policy later.
    for name in sorted(b.keys() - a.keys()):
        changes.append(("NON_BREAKING", where + "/properties/" + name, "field added"))
    for name in sorted(a.keys() & b.keys()):
        compare_schema(a[name], b[name], where + "/properties/" + name, changes)
    for name in sorted(set(old["required"]) ^ set(new["required"])):
        level = "BREAKING" if name in old["required"] else "NON_BREAKING"
        add(level, f"required guarantee {'removed' if level == 'BREAKING' else 'added'}: {name}")
    if "items" in old and "items" in new:
        compare_schema(old["items"], new["items"], where + "/items", changes)


def compare(old, new):
    changes = []
    for operation in sorted(old.keys() - new.keys()):
        changes.append(("BREAKING", operation, "operation removed"))
    for operation in sorted(new.keys() - old.keys()):
        changes.append(("NON_BREAKING", operation, "operation added"))
    for operation in sorted(old.keys() & new.keys()):
        a, b = old[operation], new[operation]
        if a["operationId"] != b["operationId"]:
            changes.append(("BREAKING", operation, "operationId changed"))
        for status in sorted(a["responses"].keys() | b["responses"].keys()):
            where = f"{operation}/responses/{status}"
            if status not in a["responses"]:
                # New error/status alternatives can break consumers; review conservatively.
                changes.append(("BREAKING", where, "response added; review required"))
                continue
            if status not in b["responses"]:
                changes.append(("BREAKING", where, "response removed"))
                continue
            am, bm = a["responses"][status], b["responses"][status]
            for mime in sorted(am.keys() - bm.keys()):
                changes.append(("BREAKING", where + "/" + mime, "media type removed"))
            for mime in sorted(bm.keys() - am.keys()):
                changes.append(("NON_BREAKING", where + "/" + mime, "media type added"))
            for mime in sorted(am.keys() & bm.keys()):
                compare_schema(am[mime], bm[mime], where + "/" + mime, changes)
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--declared", type=Path, default=FIXTURE / "openapi.json")
    parser.add_argument("--observed", type=Path, default=FIXTURE / "observed-additive.json")
    args = parser.parse_args()
    try:
        old, new = inventory(load(args.declared)), inventory(load(args.observed))
        changes = compare(old, new)
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    for level, where, detail in changes:
        print(f"{level}: {where}: {detail}")
    breaking = sum(level == "BREAKING" for level, _, _ in changes)
    print(f"{'FAIL' if breaking else 'PASS'}: {breaking} breaking, {len(changes) - breaking} non-breaking changes")
    return 1 if breaking else 0


if __name__ == "__main__":
    sys.exit(main())

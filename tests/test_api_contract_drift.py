#!/usr/bin/env python3
"""Hermetic good/missing/tampered contract fixtures for Issue #78."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/ci/check-api-contract-drift.py"
FIXTURE = ROOT / "contracts/apis/mock-rest"
spec = importlib.util.spec_from_file_location("api_contract_drift", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ContractDriftTest(unittest.TestCase):
    def setUp(self):
        self.doc = mod.load(FIXTURE / "openapi.json")

    def props(self, doc):
        return doc["components"]["schemas"]["Record"]["properties"]

    def response(self, doc):
        return doc["paths"]["/records"]["get"]["responses"]["200"]

    def changes(self, doc):
        return mod.compare(mod.inventory(self.doc), mod.inventory(doc))

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True, check=False)

    def test_checked_in_fixtures_cli(self):
        cases = [("openapi.json", 0, "0 breaking, 0 non-breaking"),
                 ("observed-additive.json", 0, "field added"),
                 ("observed-breaking.json", 1, "field removed")]
        for filename, status, message in cases:
            with self.subTest(filename=filename):
                result = self.cli("--observed", FIXTURE / filename)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn(message, result.stdout)
        self.assertIn("type changed", self.cli("--observed", FIXTURE / "observed-breaking.json").stdout)

    def test_optional_removal_type_and_rename_break(self):
        for change in ("remove", "type", "rename", "array"):
            doc = copy.deepcopy(self.doc)
            props = self.props(doc)
            if change == "remove":
                del props["name"]
            elif change == "type":
                props["id"] = {"type": "string"}
            elif change == "rename":
                props["label"] = props.pop("name")
            else:
                props["name"] = {"type": "array", "items": {"type": "integer"}}
            with self.subTest(change=change):
                self.assertTrue(any(c[0] == "BREAKING" for c in self.changes(doc)))

    def test_required_guarantee_direction(self):
        for required, expected in [([], "BREAKING"), (["id", "name"], "NON_BREAKING")]:
            doc = copy.deepcopy(self.doc)
            doc["components"]["schemas"]["Record"]["required"] = required
            self.assertEqual([c[0] for c in self.changes(doc)], [expected])

    def test_endpoint_operation_status_and_media_changes(self):
        for change, expected in [("path_removed", "BREAKING"), ("method_removed", "BREAKING"),
                                 ("id", "BREAKING"), ("status", "BREAKING"),
                                 ("media", "BREAKING"), ("added", "NON_BREAKING")]:
            doc = copy.deepcopy(self.doc)
            if change == "path_removed":
                doc["paths"]["/other"] = doc["paths"].pop("/records")
            elif change == "method_removed":
                doc["paths"]["/records"]["post"] = doc["paths"]["/records"].pop("get")
            elif change == "id":
                doc["paths"]["/records"]["get"]["operationId"] = "renamed"
            elif change == "status":
                responses = doc["paths"]["/records"]["get"]["responses"]
                responses["201"] = responses.pop("200")
            elif change == "media":
                self.response(doc)["content"] = {}
            else:
                doc["paths"]["/extra"] = copy.deepcopy(doc["paths"]["/records"])
                doc["paths"]["/extra"]["get"]["operationId"] = "extra"
            with self.subTest(change=change):
                self.assertIn(expected, [c[0] for c in self.changes(doc)])

    def test_nested_array_field_and_nullable_changes(self):
        doc = copy.deepcopy(self.doc)
        self.props(doc)["name"] = {"type": "object", "properties": {"nested": {"type": "boolean"}}}
        self.assertIn("BREAKING", [c[0] for c in self.changes(doc)])
        doc = copy.deepcopy(self.doc)
        self.props(doc)["id"]["type"] = ["integer", "null"]
        self.assertIn("BREAKING", [c[0] for c in self.changes(doc)])
        # Equivalent nullable syntax across 3.0 and 3.1 normalizes identically.
        old = copy.deepcopy(doc)
        old["openapi"] = "3.0.3"
        self.props(old)["id"] = {"type": "integer", "nullable": True}
        self.assertEqual(mod.compare(mod.inventory(old), mod.inventory(doc)), [])

    def test_invalid_documents_fail_closed_cli(self):
        bad = []
        for key in ("openapi", "info", "paths"):
            doc = copy.deepcopy(self.doc)
            del doc[key]
            bad.append(doc)
        for replacement in ({}, {"type": "bogus"}, {"type": "array"},
                            {"type": "string", "enum": ["a"]},
                            {"type": "object", "required": ["missing"]},
                            {"$ref": "https://example.invalid/schema"},
                            {"$ref": "#/components/schemas/Missing"},
                            {"$ref": "#/components/schemas/Record"}):
            doc = copy.deepcopy(self.doc)
            self.props(doc)["id"] = replacement
            bad.append(doc)
        doc = copy.deepcopy(self.doc)
        self.response(doc)["content"]["application/json"] = {}
        bad.append(doc)
        doc = copy.deepcopy(self.doc)
        doc["paths"]["/records"]["get"]["responses"] = {}
        bad.append(doc)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tampered.json"
            for i, doc in enumerate(bad):
                with self.subTest(case=i):
                    path.write_text(json.dumps(doc))
                    for side in ("--declared", "--observed"):
                        result = self.cli(side, path)
                        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                        self.assertIn("ERROR:", result.stderr)
                        self.assertNotIn("Traceback", result.stderr)
            for text in ('{', '{"openapi":"3.1.0","openapi":"3.0.3"}', '[]'):
                path.write_text(text)
                self.assertEqual(self.cli("--observed", path).returncode, 2)
            self.assertEqual(self.cli("--observed", Path(tmp) / "missing.json").returncode, 2)

    def test_ref_and_inline_equivalence_and_annotations(self):
        doc = copy.deepcopy(self.doc)
        schema = self.response(doc)["content"]["application/json"]["schema"]
        schema["properties"]["records"]["items"] = copy.deepcopy(doc["components"]["schemas"]["Record"])
        schema["description"] = "annotation only"
        doc["info"]["version"] = "1.0.1"
        self.assertEqual(self.changes(doc), [])


if __name__ == "__main__":
    unittest.main()
